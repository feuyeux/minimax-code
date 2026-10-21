import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changelogFile,
  controlFile,
  copyrightFile,
  debFileName,
  debVersion,
  debianArchitecture,
  debianNodeDependency,
  upstreamVersion,
} from '../scripts/lib/deb-release.mjs';

test('maps Node.js architectures to Debian architectures', () => {
  assert.equal(debianArchitecture('x64'), 'amd64');
  assert.equal(debianArchitecture('arm64'), 'arm64');
  assert.equal(debianArchitecture('arm'), 'armhf');
  assert.throws(() => debianArchitecture('ppc64'), /No Debian architecture/);
});

test('converts semver versions and revisions into Debian versions', () => {
  assert.equal(debVersion('0.6.5'), '0.6.5-1');
  assert.equal(debVersion('0.6.5', '2'), '0.6.5-2');
  assert.equal(debVersion('0.7.0-rc.1'), '0.7.0~rc.1-1');
  assert.equal(upstreamVersion('0.7.0~rc.1-1'), '0.7.0~rc.1');
  assert.equal(debFileName({ version: '0.6.5', architecture: 'amd64' }), 'minimax-code_0.6.5-1_amd64.deb');
  assert.throws(() => debVersion('invalid version'), /Cannot convert/);
  assert.throws(() => debVersion('0.6.5', 'bad/rev'), /Invalid Debian revision/);
});

test('pins the Node.js dependency to the ABI-compatible major line', () => {
  assert.deepEqual(debianNodeDependency('22.19.0'), {
    depends: 'nodejs (>= 22.19), nodejs (<< 23)', nodeMajor: 22, nodeRange: '22.19-22.x',
  });
  assert.deepEqual(debianNodeDependency('24.2.0'), {
    depends: 'nodejs (>= 24.2), nodejs (<< 25)', nodeMajor: 24, nodeRange: '24.2-24.x',
  });
  assert.deepEqual(debianNodeDependency('26.0.0'), {
    depends: 'nodejs (>= 26), nodejs (<< 27)', nodeMajor: 26, nodeRange: '26.x',
  });
  assert.throws(() => debianNodeDependency('23.1.0'), /No Debian nodejs dependency/);
  assert.throws(() => debianNodeDependency('27.0.0'), /No Debian nodejs dependency/);
});

test('formats the Debian control file deterministically', () => {
  const control = controlFile({
    version: '0.6.5',
    revision: '1',
    architecture: 'amd64',
    installedSizeKb: 1024,
    depends: 'nodejs (>= 24.2), nodejs (<< 25)',
  });
  const lines = control.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    'Package: minimax-code',
    'Version: 0.6.5-1',
    'Architecture: amd64',
    'Maintainer: MiniMax Code Contributors <minimax-code@users.noreply.github.com>',
    'Installed-Size: 1024',
    'Depends: nodejs (>= 24.2), nodejs (<< 25)',
    'Section: devel',
    'Priority: optional',
    'Homepage: https://github.com/MiniMax-AI/minimax-code',
  ]);
  const description = lines.slice(9);
  assert.equal(description[0], 'Description: terminal coding agent for MiniMax models');
  assert.ok(description.slice(1).every(line => line.startsWith(' ')), 'extended description lines must be indented');
  assert.ok(description.includes(' .'), 'paragraphs must be separated by a single dot');
  assert.ok(control.endsWith('\n'));
  assert.throws(() => controlFile({ version: '0.6.5', architecture: 'amd64', installedSizeKb: 0, depends: 'nodejs' }), /positive integer/);
});

test('wraps the MIT license in Debian copyright format', () => {
  const copyright = copyrightFile('MIT License\n\nCopyright (c) 2026 MiniMax Code\n');
  assert.match(copyright, /^Format: https:\/\/www\.debian\.org\/doc\/packaging-manuals\/copyright-format\/1\.0\/$/m);
  assert.match(copyright, /^Upstream-Name: minimax-code$/m);
  assert.match(copyright, /^License: MIT$/m);
  assert.match(copyright, /^ MIT License$/m);
  assert.match(copyright, /^ \.$/m);
  assert.match(copyright, /^ Copyright \(c\) 2026 MiniMax Code$/m);
});

test('formats the Debian changelog entry', () => {
  const changelog = changelogFile({
    version: '0.6.5',
    revisionId: 'a'.repeat(40),
    now: new Date('2026-10-21T12:34:56Z'),
  });
  assert.match(changelog, /^minimax-code \(0\.6\.5-1\) unstable; urgency=medium$/m);
  assert.match(changelog, /^  \* Package MiniMax Code 0\.6\.5 from public source revision a{40}\.$/m);
  assert.match(changelog, /^ -- MiniMax Code Contributors <minimax-code@users\.noreply\.github\.com>  Wed, 21 Oct 2026 12:34:56 \+0000$/m);
  assert.match(changelog, /\n$/);
});
