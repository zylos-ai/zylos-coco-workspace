#!/usr/bin/env node

/**
 * Post-upgrade hook for zylos-coco-workspace v1.0.79 (final release).
 *
 * Migrates coco-workspace → openmax:
 *   1. Installs zylos-openmax from GitHub
 *   2. Copies config and runtime data
 *   3. Switches PM2 service
 *   4. Updates components.json and registry.json
 *
 * Idempotent: re-running when openmax is already installed is a no-op.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const HOME = process.env.HOME;
const SKILLS_DIR = path.join(HOME, 'zylos/.claude/skills');
const COMPONENTS_DIR = path.join(HOME, 'zylos/components');
const ZYLOS_DIR = path.join(HOME, 'zylos/.zylos');
const COMPONENTS_FILE = path.join(ZYLOS_DIR, 'components.json');
const REGISTRY_FILE = path.join(ZYLOS_DIR, 'registry.json');

const OLD_NAME = 'coco-workspace';
const NEW_NAME = 'openmax';
const NEW_REPO = 'zylos-ai/zylos-openmax';
const NEW_TAG = 'v2.0.0';

const oldSkillDir = path.join(SKILLS_DIR, OLD_NAME);
const newSkillDir = path.join(SKILLS_DIR, NEW_NAME);
const oldDataDir = path.join(COMPONENTS_DIR, OLD_NAME);
const newDataDir = path.join(COMPONENTS_DIR, NEW_NAME);

function log(msg) { console.log(`[migrate] ${msg}`); }
function warn(msg) { console.log(`[migrate] ⚠ ${msg}`); }

// ── Check if already migrated ──────────────────────────────────────────────
if (fs.existsSync(newSkillDir) && fs.existsSync(path.join(newSkillDir, 'SKILL.md'))) {
  log('openmax is already installed — skipping migration.');
  process.exit(0);
}

log('Migrating coco-workspace → openmax...');

// ── Step 1: Clone zylos-openmax ────────────────────────────────────────────
log('Step 1/6: Downloading openmax...');
try {
  if (fs.existsSync(newSkillDir)) fs.rmSync(newSkillDir, { recursive: true });
  execSync(
    `git clone --depth 1 --branch ${NEW_TAG} https://github.com/${NEW_REPO}.git "${newSkillDir}"`,
    { stdio: 'pipe', timeout: 120000 }
  );
  // Remove .git to save space — this is an installed component, not a dev checkout
  fs.rmSync(path.join(newSkillDir, '.git'), { recursive: true, force: true });
  log('  Download complete.');
} catch (e) {
  warn(`Failed to clone openmax: ${e.message}`);
  warn('Migration aborted. You can install manually: zylos add zylos-ai/zylos-openmax');
  process.exit(1);
}

// ── Step 2: npm install ────────────────────────────────────────────────────
log('Step 2/6: Installing dependencies...');
try {
  execSync('npm install --omit=dev', {
    cwd: newSkillDir,
    stdio: 'pipe',
    timeout: 300000,
  });
  log('  Dependencies installed.');
} catch (e) {
  warn(`npm install failed: ${e.message}`);
  warn('Migration aborted. You can install manually: zylos add zylos-ai/zylos-openmax');
  fs.rmSync(newSkillDir, { recursive: true, force: true });
  process.exit(1);
}

// ── Step 3: Create data directory and copy preserved files ─────────────────
log('Step 3/6: Migrating data...');
fs.mkdirSync(newDataDir, { recursive: true });

const preserveFiles = ['config.json', 'mention-registry.json', 'smoke-config.json'];
for (const f of preserveFiles) {
  const src = path.join(oldDataDir, f);
  const dst = path.join(newDataDir, f);
  if (fs.existsSync(src)) {
    try {
      fs.copyFileSync(src, dst);
      log(`  Copied ${f}`);
    } catch (e) {
      warn(`  Failed to copy ${f}: ${e.message}`);
    }
  }
}

const preserveDirs = ['runtime', 'media', 'logs'];
for (const d of preserveDirs) {
  const src = path.join(oldDataDir, d);
  const dst = path.join(newDataDir, d);
  if (fs.existsSync(src)) {
    try {
      execSync(`cp -a "${src}" "${dst}"`, { stdio: 'pipe' });
      log(`  Copied ${d}/`);
    } catch (e) {
      warn(`  Failed to copy ${d}/: ${e.message}`);
    }
  }
}

// ── Step 4: Update components.json ─────────────────────────────────────────
log('Step 4/6: Updating component registry...');
try {
  let components = {};
  if (fs.existsSync(COMPONENTS_FILE)) {
    components = JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8'));
  }

  // Add openmax entry
  components[NEW_NAME] = {
    version: '2.0.0',
    repo: NEW_REPO,
    type: 'declarative',
    isThirdParty: false,
    installedAt: new Date().toISOString(),
    skillDir: newSkillDir,
    dataDir: newDataDir,
    migratedFrom: OLD_NAME,
  };

  // Remove old entry
  delete components[OLD_NAME];

  fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(components, null, 2));
  log('  components.json updated.');
} catch (e) {
  warn(`Failed to update components.json: ${e.message}`);
}

// Update registry.json
try {
  let registry = { components: {} };
  if (fs.existsSync(REGISTRY_FILE)) {
    registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  }

  registry.components[NEW_NAME] = {
    repo: NEW_REPO,
    description: 'OpenMax native communication + service CLIs for Zylos agents',
    type: 'communication',
    official: true,
  };
  delete registry.components[OLD_NAME];

  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  log('  registry.json updated.');
} catch (e) {
  warn(`Failed to update registry.json: ${e.message}`);
}

// ── Step 5: Switch PM2 service ─────────────────────────────────────────────
log('Step 5/6: Switching service...');

// Stop old service
try {
  execSync('pm2 stop zylos-coco-workspace 2>/dev/null; pm2 delete zylos-coco-workspace 2>/dev/null', {
    stdio: 'pipe',
    shell: true,
  });
  log('  Stopped zylos-coco-workspace.');
} catch {
  // Service might not be running
}

// Start new service
try {
  const ecoConfig = path.join(newSkillDir, 'ecosystem.config.cjs');
  if (fs.existsSync(ecoConfig)) {
    execSync(`pm2 start "${ecoConfig}"`, { stdio: 'pipe' });
    execSync('pm2 save', { stdio: 'pipe' });
    log('  Started zylos-openmax.');
  } else {
    warn('  ecosystem.config.cjs not found — start the service manually.');
  }
} catch (e) {
  warn(`  Failed to start zylos-openmax: ${e.message}`);
  warn('  Start manually: pm2 start ~/zylos/.claude/skills/openmax/ecosystem.config.cjs');
}

// ── Step 6: Clean up old skill directory ───────────────────────────────────
log('Step 6/6: Cleanup...');
// Don't remove the old data dir (config might be referenced as backup)
// The old skill dir will contain the v1.0.79 code — leave it as a breadcrumb
// Users can run `zylos uninstall coco-workspace --purge` to fully clean up
log('  Old data preserved at ~/zylos/components/coco-workspace/ (safe to remove).');
log('  Old skill preserved at ~/.claude/skills/coco-workspace/ (safe to remove).');

// ── Done ───────────────────────────────────────────────────────────────────
console.log('');
console.log('  ✓ Migration complete: coco-workspace → openmax');
console.log('');
console.log('  New component: openmax v2.0.0');
console.log('  Service:       pm2 zylos-openmax');
console.log('  Config:        ~/zylos/components/openmax/config.json');
console.log('  Upgrade:       zylos upgrade openmax');
console.log('');
console.log('  Old files preserved for reference (safe to remove):');
console.log('    ~/zylos/components/coco-workspace/');
console.log('    ~/.claude/skills/coco-workspace/');
console.log('');
