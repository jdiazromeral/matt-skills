import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve primary repo root even if running inside a git worktree
let REPO = path.resolve(__dirname, '..');
try {
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: REPO, encoding: 'utf-8' }).trim();
  if (gitCommonDir) {
    const candidate = path.isAbsolute(gitCommonDir) ? path.resolve(gitCommonDir, '..') : path.resolve(REPO, gitCommonDir, '..');
    if (fs.existsSync(path.join(candidate, 'skills'))) {
      REPO = candidate;
    }
  }
} catch {}

const PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'matt');
const CONFIG_JSON = path.join(os.homedir(), '.gemini', 'config', 'config.json');

// Read version from package.json or claude plugin manifest
let version = '1.0.0';
let description = "Matt Pocock's agent skills for engineering and productivity (namespaced under matt:*)";

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
  if (pkg.version) version = pkg.version;
  if (pkg.description) description = pkg.description;
} catch {}

try {
  const claudePkg = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf-8'));
  if (claudePkg.version) version = claudePkg.version;
  if (claudePkg.description) description = claudePkg.description;
} catch {}

console.log(`Building AGY plugin 'matt' (v${version}) from ${REPO}`);
console.log(`Target plugin directory: ${PLUGIN_DIR}`);

// 1. Ensure target directories exist
const skillsTargetDir = path.join(PLUGIN_DIR, 'skills');
fs.mkdirSync(skillsTargetDir, { recursive: true });

// 2. Find all SKILL.md files
function findSkills(dir, list = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'deprecated') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSkills(fullPath, list);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      list.push(fullPath);
    }
  }
  return list;
}

const skillFiles = findSkills(path.join(REPO, 'skills'));
const activeSkillNames = new Set();
const skillPathsForManifest = [];

for (const skillMdPath of skillFiles) {
  const skillSrcDir = path.dirname(skillMdPath);
  const skillName = path.basename(skillSrcDir);
  activeSkillNames.add(skillName);

  const destSkillDir = path.join(skillsTargetDir, skillName);
  fs.mkdirSync(destSkillDir, { recursive: true });

  // Symlink all auxiliary files/dirs from source to target (except SKILL.md)
  const srcEntries = fs.readdirSync(skillSrcDir, { withFileTypes: true });
  for (const entry of srcEntries) {
    if (entry.name === 'SKILL.md') continue;
    const srcEntryPath = path.join(skillSrcDir, entry.name);
    const destEntryPath = path.join(destSkillDir, entry.name);

    const stat = fs.lstatSync(destEntryPath, { throwIfNoEntry: false });
    if (stat) {
      fs.rmSync(destEntryPath, { recursive: true, force: true });
    }
    fs.symlinkSync(srcEntryPath, destEntryPath);
  }

  // Read and transform SKILL.md for AGY plugin (Antigravity automatically prefixes plugin name)
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  let transformed = content;

  if (transformed.startsWith('---')) {
    const endIdx = transformed.indexOf('---', 3);
    if (endIdx !== -1) {
      let frontmatter = transformed.slice(3, endIdx);
      const rest = transformed.slice(endIdx);

      if (/^name:\s*.+$/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(/^name:\s*.+$/m, `name: "${skillName}"`);
      } else {
        frontmatter = `\nname: "${skillName}"` + frontmatter;
      }

      // If description exists and doesn't mention /matt:skillName, add invoke guidance
      if (/^description:\s*(.+)$/m.test(frontmatter) && !frontmatter.includes(`/matt:${skillName}`)) {
        frontmatter = frontmatter.replace(/^description:\s*["']?(.*?)["']?$/m, (match, desc) => {
          return `description: >-\n  ${desc.trim()} Use when the user invokes /matt:${skillName} or asks for Matt's ${skillName} skill.`;
        });
      }
      
      transformed = `---${frontmatter}${rest}`;
    }
  } else {
    transformed = `---\nname: "${skillName}"\ndescription: >-\n  Matt Pocock's ${skillName} skill. Use when the user invokes /matt:${skillName}.\n---\n\n${transformed}`;
  }

  const destSkillMd = path.join(destSkillDir, 'SKILL.md');
  fs.writeFileSync(destSkillMd, transformed, 'utf-8');
  skillPathsForManifest.push(`skills/${skillName}`);
  console.log(`  ✓ Linked: matt:${skillName} (from ${path.relative(REPO, skillSrcDir)})`);
}

// 3. Remove stale skills in target directory
const existingSkillDirs = fs.readdirSync(skillsTargetDir, { withFileTypes: true });
for (const entry of existingSkillDirs) {
  if (entry.isDirectory() && !activeSkillNames.has(entry.name)) {
    const staleDir = path.join(skillsTargetDir, entry.name);
    fs.rmSync(staleDir, { recursive: true, force: true });
    console.log(`  ✗ Removed stale skill: ${entry.name}`);
  }
}

// 4. Generate plugin.json
skillPathsForManifest.sort();
const manifest = {
  name: 'matt',
  version,
  description: `${description} (namespaced under matt:*)`,
  homepage: 'https://github.com/jdiazromeral/matt-skills',
  repository: 'https://github.com/jdiazromeral/matt-skills',
  license: 'MIT',
  skills: skillPathsForManifest
};

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'plugin.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf-8'
);
console.log(`  ✓ Generated ${path.join(PLUGIN_DIR, 'plugin.json')}`);

// 5. Ensure plugin is enabled in ~/.gemini/config/config.json
try {
  let config = {};
  if (fs.existsSync(CONFIG_JSON)) {
    config = JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf-8'));
  }
  if (!config.plugins) {
    config.plugins = {};
  }
  config.plugins.matt = { enabled: true };
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  ✓ Enabled 'matt' in ${CONFIG_JSON}`);
} catch (err) {
  console.warn(`  ! Could not update config.json: ${err.message}`);
}

console.log(`\nDone! Successfully installed ${skillPathsForManifest.length} namespaced skills in AGY plugin 'matt'.`);
