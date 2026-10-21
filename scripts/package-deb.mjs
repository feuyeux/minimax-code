import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cliBuildVersion } from './lib/cli-release.mjs';
import {
  changelogFile,
  controlFile,
  copyrightFile,
  debFileName,
  debianArchitecture,
  debVersion,
  debianNodeDependency,
  debPackageName,
} from './lib/deb-release.mjs';
import { stageCliRelease } from './package-cli-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function requireDpkg() {
  const result = spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('dpkg-deb is required to build a Debian package. Install dpkg-dev.');
}

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute, relative) : [{ absolute, relative, entry }];
  });
}

function setMtime(directory, epoch) {
  for (const { absolute, entry } of walk(directory)) {
    if (entry.isSymbolicLink()) continue;
    utimesSync(absolute, epoch, epoch);
  }
}

function directorySizeKb(rootDirectory) {
  let bytes = 0;
  for (const { absolute, entry } of walk(rootDirectory)) {
    if (entry.isFile()) bytes += statSync(absolute).size;
  }
  return Math.ceil(bytes / 1024);
}

function md5sums(rootDirectory) {
  return walk(rootDirectory)
    .filter(({ relative, entry }) => entry.isFile() && !relative.startsWith('DEBIAN/'))
    .map(({ absolute, relative }) => `${createHash('md5').update(readFileSync(absolute)).digest('hex')}  ${relative}`)
    .sort()
    .join('\n') + '\n';
}

function installRuntimeDependencies(stage, temporary) {
  const home = path.join(temporary, 'npm-home');
  const cache = path.join(temporary, 'npm-cache');
  mkdirSync(home, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^npm_config_/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    HOME: home,
    npm_config_cache: cache,
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  });
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const npmMajor = Number(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim().split('.')[0]);
  const npmrc = path.join(home, '.npmrc');
  // npm 11 refuses --allow-scripts for project installs; the equivalent user
  // configuration keeps the native SQLite build enabled without a lockfile.
  writeFileSync(npmrc, npmMajor >= 11 ? 'allow-scripts=better-sqlite3\n' : '');
  const args = [
    'install', '--omit=dev', '--include=optional', '--ignore-scripts=false',
    '--no-audit', '--no-fund', '--no-package-lock',
    '--registry=https://registry.npmjs.org/',
  ];
  execFileSync('npm', args, { cwd: stage, env, stdio: 'inherit', timeout: 600000 });
  for (const name of ['package-lock.json', 'node_modules/.package-lock.json'])
    rmSync(path.join(stage, name), { force: true });
}

export async function packageDeb({
  tag,
  out = path.join(root, 'dist/deb'),
  arch,
  revision = '1',
  allowDirty = false,
  nodeVersion = process.versions.node,
} = {}) {
  if (process.platform !== 'linux') throw new Error('Debian packages can only be built on Linux.');
  requireDpkg();
  const buildArchitecture = debianArchitecture(process.arch);
  const architecture = arch ?? buildArchitecture;
  if (architecture !== buildArchitecture)
    throw new Error(`Cannot cross-build a Debian package for ${architecture} on ${buildArchitecture}: native modules must match the target architecture.`);
  const nodeDependency = debianNodeDependency(nodeVersion);
  if (Number(nodeVersion.split('.')[0]) !== Number(process.versions.node.split('.')[0]))
    throw new Error(`--node ${nodeVersion} differs from the packaging runtime Node.js ${process.versions.node}; native modules would target the wrong ABI.`);
  const version = cliBuildVersion(root, tag);
  const releaseTag = tag ?? process.env.MCODE_RELEASE_TAG ?? `v${version}`;
  const staged = stageCliRelease({ tag: releaseTag, requireClean: !allowDirty, requireRevision: false });
  const { stage, temporary, revision: revisionId } = staged;
  try {
    installRuntimeDependencies(stage, temporary);
    const packageRoot = path.join(temporary, 'deb');
    const application = path.join(packageRoot, 'usr/lib', debPackageName);
    const documentation = path.join(packageRoot, 'usr/share/doc', debPackageName);
    const control = path.join(packageRoot, 'DEBIAN');
    mkdirSync(path.dirname(application), { recursive: true });
    mkdirSync(path.join(packageRoot, 'usr/bin'), { recursive: true });
    mkdirSync(documentation, { recursive: true });
    mkdirSync(control, { recursive: true });
    // verbatimSymlinks keeps npm's relative node_modules/.bin links relative;
    // the default rewrites them to absolute build-directory paths.
    cpSync(stage, application, { recursive: true, verbatimSymlinks: true });
    symlinkSync(`../lib/${debPackageName}/cli.js`, path.join(packageRoot, 'usr/bin/mcode'));
    chmodSync(path.join(application, 'cli.js'), 0o755);

    const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    writeFileSync(path.join(documentation, 'copyright'), copyrightFile(license));
    writeFileSync(path.join(documentation, 'changelog.Debian.gz'), gzipSync(changelogFile({
      version, revision, revisionId,
    }), { level: 9 }));
    writeFileSync(path.join(documentation, 'README.md'), `# MiniMax Code ${version}

Built from https://github.com/MiniMax-AI/minimax-code/tree/${revisionId}.

The compiled CLI is installed in /usr/lib/${debPackageName} and the mcode
command is available in /usr/bin. This package depends on a compatible system
Node.js runtime (${nodeDependency.nodeRange}) and does not bundle Node.js.
Run \`mcode --help\`, \`mcode exec <prompt>\`, or \`mcode login\`. User data defaults
to ~/.minimax and can be overridden with MINIMAX_DATA_DIR.

See https://github.com/MiniMax-AI/minimax-code/blob/${revisionId}/docs/installation.md.
`);

    const epoch = Number(process.env.SOURCE_DATE_EPOCH || execFileSync('git', ['show', '-s', '--format=%ct', revisionId], { cwd: root, encoding: 'utf8' }).trim());
    setMtime(packageRoot, epoch);
    writeFileSync(path.join(control, 'control'), controlFile({
      version,
      revision,
      architecture,
      installedSizeKb: directorySizeKb(packageRoot),
      depends: nodeDependency.depends,
      paragraphs: [
        'MiniMax Code is a terminal coding agent with an interactive TUI, a headless',
        'CLI, managed accounts, BYOK providers, plugins, MCP and ACP support.',
        'This package installs the compiled CLI under /usr/lib/minimax-code and',
        'provides the mcode command. It requires a compatible system Node.js runtime',
        `(${nodeDependency.nodeRange}) and does not bundle one.`,
      ],
    }));
    writeFileSync(path.join(control, 'md5sums'), md5sums(packageRoot));

    mkdirSync(out, { recursive: true });
    const archive = path.join(out, debFileName({ version, revision, architecture }));
    if (existsSync(archive) || existsSync(`${archive}.sha256`)) throw new Error(`Output already exists: ${archive}`);
    execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', packageRoot, archive], {
      stdio: 'inherit',
      env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
    });
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({
      archive,
      package: debPackageName,
      version: debVersion(version, revision),
      architecture,
      depends: nodeDependency.depends,
      sha256: digest,
    }, null, 2));
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(root, 'dist/deb') },
      tag: { type: 'string' },
      arch: { type: 'string' },
      revision: { type: 'string', default: '1' },
      'allow-dirty': { type: 'boolean', default: false },
      node: { type: 'string' },
    },
  });
  await packageDeb({
    tag: values.tag,
    out: path.resolve(values.out),
    arch: values.arch,
    revision: values.revision,
    allowDirty: values['allow-dirty'],
    nodeVersion: values.node,
  });
}
