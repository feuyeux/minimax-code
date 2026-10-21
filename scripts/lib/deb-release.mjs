// Debian package metadata helpers shared by the packager, verifier and tests.
// The package depends on the host Node.js runtime and therefore ships a native
// SQLite binding built for one Node ABI (see debianNodeDependency).

export const debPackageName = 'minimax-code';
export const debHomepage = 'https://github.com/MiniMax-AI/minimax-code';
export const debMaintainer = 'MiniMax Code Contributors <minimax-code@users.noreply.github.com>';

const nodeMajorRanges = new Map([
  [22, { range: '(>= 22.19), nodejs (<< 23)', description: '22.19-22.x' }],
  [23, null],
  [24, { range: '(>= 24.2), nodejs (<< 25)', description: '24.2-24.x' }],
  [25, { range: '(>= 25), nodejs (<< 26)', description: '25.x' }],
  [26, { range: '(>= 26), nodejs (<< 27)', description: '26.x' }],
]);

const architectures = new Map([
  ['x64', 'amd64'],
  ['arm64', 'arm64'],
  ['arm', 'armhf'],
  ['ia32', 'i386'],
]);

export function debianArchitecture(nodeArch = process.arch) {
  const architecture = architectures.get(nodeArch);
  if (!architecture) throw new Error(`No Debian architecture mapping for Node.js architecture ${nodeArch}.`);
  return architecture;
}

// Native dependencies (better-sqlite3) use the V8 ABI, so a prebuilt Debian
// package can only run on the Node.js major line used to package it.
export function debianNodeDependency(nodeVersion = process.versions.node) {
  const major = Number(nodeVersion.split('.')[0]);
  const entry = nodeMajorRanges.get(major);
  if (!entry) throw new Error(`No Debian nodejs dependency for Node.js ${nodeVersion}. Build the package with a supported Node.js major (22, 24, 25 or 26).`);
  return { depends: `nodejs ${entry.range}`, nodeMajor: major, nodeRange: entry.description };
}

// Debian splits the upstream version from the package revision at the last
// hyphen, so semver prerelease hyphens become tildes (0.7.0-rc.1 -> 0.7.0~rc.1).
export function debVersion(version, revision = '1') {
  if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+~:-]*$/.test(version.replaceAll('-', '~')))
    throw new Error(`Cannot convert ${version} to a Debian version.`);
  if (typeof revision !== 'string' || !/^[0-9][0-9A-Za-z.+~]*$/.test(revision))
    throw new Error(`Invalid Debian revision ${revision}.`);
  return `${version.replaceAll('-', '~')}-${revision}`;
}

export function upstreamVersion(deb) {
  const index = deb.lastIndexOf('-');
  return index < 0 ? deb : deb.slice(0, index);
}

export function debFileName({ name = debPackageName, version, revision = '1', architecture }) {
  return `${name}_${debVersion(version, revision)}_${architecture}.deb`;
}

function formatDescription(short, paragraphs) {
  const lines = [`Description: ${short}`];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) lines.push(' .');
    for (const line of paragraph.split('\n')) lines.push(` ${line}`.trimEnd());
  });
  return lines.join('\n');
}

export function controlFile({
  name = debPackageName,
  version,
  revision = '1',
  architecture,
  installedSizeKb,
  depends,
  maintainer = debMaintainer,
  homepage = debHomepage,
  description = 'terminal coding agent for MiniMax models',
  paragraphs = [
    'MiniMax Code is a terminal coding agent with an interactive TUI, a headless',
    'CLI, managed accounts, BYOK providers, plugins, MCP and ACP support.',
    'This package installs the compiled CLI under /usr/lib/minimax-code and',
    'provides the mcode command. It requires a compatible system Node.js runtime',
    'and does not bundle one.',
  ],
}) {
  if (!Number.isInteger(installedSizeKb) || installedSizeKb <= 0) throw new Error('installedSizeKb must be a positive integer.');
  if (!depends) throw new Error('depends is required.');
  return [
    `Package: ${name}`,
    `Version: ${debVersion(version, revision)}`,
    `Architecture: ${architecture}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${installedSizeKb}`,
    `Depends: ${depends}`,
    'Section: devel',
    'Priority: optional',
    `Homepage: ${homepage}`,
    formatDescription(description, paragraphs),
    '',
  ].join('\n');
}

export function copyrightFile(licenseText, { name = debPackageName, homepage = debHomepage } = {}) {
  const body = licenseText.trimEnd().split('\n').map(line => (line ? ` ${line}` : ' .')).join('\n');
  return [
    'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/',
    `Upstream-Name: ${name}`,
    `Source: ${homepage}`,
    '',
    'Files: *',
    'Copyright: 2026 MiniMax Code',
    'License: MIT',
    body,
    '',
  ].join('\n');
}

export function changelogFile({ version, revision = '1', revisionId, now = new Date(), maintainer = debMaintainer }) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = value => String(value).padStart(2, '0');
  const date = `${days[now.getUTCDay()]}, ${pad(now.getUTCDate())} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} +0000`;
  return [
    `${debPackageName} (${debVersion(version, revision)}) unstable; urgency=medium`,
    '',
    `  * Package MiniMax Code ${version} from public source revision ${revisionId}.`,
    '',
    ` -- ${maintainer}  ${date}`,
    '',
  ].join('\n');
}

export function md5sumsLine(hash, relativePath) {
  return `${hash}  ${relativePath}`;
}
