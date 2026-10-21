import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { debPackageName, debianArchitecture, upstreamVersion } from './lib/deb-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute, relative) : [{ absolute, relative, entry }];
  });
}

function readFields(archive) {
  const output = execFileSync('dpkg-deb', ['--field', archive, 'Package', 'Version', 'Architecture', 'Depends', 'Installed-Size', 'Homepage'], { encoding: 'utf8' });
  return Object.fromEntries(output.trimEnd().split('\n').map(line => {
    const index = line.indexOf(':');
    assert.ok(index > 0, `unexpected dpkg-deb field line: ${line}`);
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}

function packageInfo(archive) {
  const fields = readFields(archive);
  return {
    name: fields.Package,
    version: fields.Version,
    architecture: fields.Architecture,
    depends: fields.Depends,
    installedSize: fields['Installed-Size'],
    homepage: fields.Homepage,
  };
}

export async function verifyDeb({ archive: requested, build = false, out }) {
  assert.equal(process.platform, 'linux', 'Debian package verification requires Linux.');
  assert.equal(spawnSync('dpkg-deb', ['--version']).status, 0, 'dpkg-deb is required.');
  let archive = requested;
  if (build || !archive) {
    const { packageDeb } = await import('./package-deb.mjs');
    archive = await packageDeb({ out: out ?? path.join(root, 'dist/deb'), allowDirty: process.env.MCODE_DEB_ALLOW_DIRTY === '1' });
  }
  archive = path.resolve(archive);
  assert.ok(existsSync(archive), `Missing Debian package: ${archive}`);

  if (existsSync(`${archive}.sha256`)) {
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${digest}  ${path.basename(archive)}\n`, 'Debian package checksum mismatch');
  }

  const info = packageInfo(archive);
  assert.equal(info.name, debPackageName, 'unexpected package name');
  assert.equal(info.architecture, debianArchitecture(process.arch), 'package architecture does not match the host');
  assert.match(info.depends, /\bnodejs\b/, 'package must depend on the system Node.js runtime');
  assert.match(info.depends, /nodejs \(>=/, 'Node.js dependency must carry a minimum version');
  assert.ok(Number(info.installedSize) > 0, 'Installed-Size must be positive');
  assert.equal(info.homepage, 'https://github.com/MiniMax-AI/minimax-code');

  const temporary = mkdtempSync(path.join(tmpdir(), 'mcode-deb-verify-'));
  try {
    const extracted = path.join(temporary, 'root');
    const control = path.join(temporary, 'control');
    mkdirSync(extracted);
    execFileSync('dpkg-deb', ['--extract', archive, extracted], { stdio: 'inherit' });
    execFileSync('dpkg-deb', ['--control', archive, control], { stdio: 'inherit' });

    // Only the documented layout may ship, and no maintainer script may run as root.
    for (const { relative, entry } of walk(extracted)) {
      assert.ok(/^(usr\/bin\/mcode|usr\/lib\/minimax-code|usr\/share\/doc\/minimax-code)(\/|$)/u.test(relative), `unexpected path in package: ${relative}`);
      if (entry.isFile()) {
        const mode = statSync(path.join(extracted, relative)).mode & 0o7777;
        assert.equal(mode & 0o6000, 0, `setuid/setgid file in package: ${relative}`);
      }
      if (entry.isSymbolicLink()) {
        const link = path.join(extracted, relative);
        assert.ok(existsSync(link), `dangling symlink in package: ${relative} -> ${readlinkSync(link)}`);
        const target = realpathSync(link);
        assert.ok(target.startsWith(`${realpathSync(extracted)}/`), `symlink escapes the package: ${relative} -> ${target}`);
      }
    }
    for (const name of ['preinst', 'postinst', 'prerm', 'postrm', 'config', 'triggers']) {
      assert.equal(existsSync(path.join(control, name)), false, `unexpected maintainer script: ${name}`);
    }
    assert.ok(existsSync(path.join(control, 'control')));
    assert.ok(existsSync(path.join(control, 'md5sums')));

    const launcher = path.join(extracted, 'usr/bin/mcode');
    assert.ok(lstatSync(launcher).isSymbolicLink(), '/usr/bin/mcode must be a symlink');
    const application = path.join(extracted, 'usr/lib', debPackageName);
    const cli = path.join(application, 'cli.js');
    assert.ok(existsSync(cli), 'missing compiled CLI');
    assert.ok(statSync(cli).mode & 0o111, 'compiled CLI must be executable');
    assert.ok(existsSync(path.join(application, 'node_modules', 'better-sqlite3')), 'runtime dependencies are not bundled');
    for (const name of ['copyright', 'changelog.Debian.gz']) {
      assert.ok(existsSync(path.join(extracted, 'usr/share/doc', debPackageName, name)), `missing ${name}`);
    }
    const receipt = JSON.parse(readFileSync(path.join(application, 'release.json'), 'utf8'));
    assert.equal(receipt.version, upstreamVersion(info.version));
    assert.match(receipt.revision, /^[0-9a-f]{40}$/u);

    const home = path.join(temporary, 'home');
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      MINIMAX_DATA_DIR: path.join(home, 'data'),
      MAVIS_DATA_DIR: path.join(home, 'data'),
      MCODE_DISABLE_TELEMETRY: '1',
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const reported = execFileSync(launcher, ['--version'], { cwd: home, env, encoding: 'utf8', timeout: 60000 }).trim();
    assert.equal(reported, upstreamVersion(info.version), 'mcode --version does not match the package version');
    execFileSync(launcher, ['--help'], { cwd: home, env, stdio: 'ignore', timeout: 60000 });

    const require = createRequire(path.join(application, 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      assert.equal(db.prepare('select 42 as value').get().value, 42);
    } finally {
      db.close();
    }
    assert.match(execFileSync(require('@vscode/ripgrep').rgPath, ['--version'], { encoding: 'utf8' }), /ripgrep/u);

    if (process.env.MCODE_VERIFY_REPORT_DIR) {
      mkdirSync(process.env.MCODE_VERIFY_REPORT_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MCODE_VERIFY_REPORT_DIR, 'deb-package.json'), JSON.stringify({
        status: 'PASS',
        archive: path.basename(archive),
        version: info.version,
        architecture: info.architecture,
        depends: info.depends,
        sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
        node: process.version,
      }, null, 2) + '\n');
    }
    console.log(`Verified Debian package ${path.basename(archive)}: ${info.name} ${info.version} ${info.architecture}, depends ${info.depends}`);
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      build: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  await verifyDeb({
    archive: values.archive ?? process.env.MCODE_DEB_ARCHIVE,
    build: values.build,
    out: values.out ? path.resolve(values.out) : undefined,
  });
}
