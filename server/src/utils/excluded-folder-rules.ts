import { isWithinRelativeRoot, normalizePath, splitPathSegments } from './path-utils.js';

const EDGE_SLASH_PATTERN = /^\/+|\/+$/g;
const UNSUPPORTED_PATTERN = /[*?]/;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRuleSegments(value: string): string[] {
  return normalizePath(value)
    .trim()
    .replace(EDGE_SLASH_PATTERN, '')
    .split('/')
    .filter(Boolean);
}

export function normalizeExcludedFolderRule(rule: string): string {
  const segments = normalizeRuleSegments(rule);

  if (segments.length === 0) {
    throw new Error('Excluded folder rules cannot be empty.');
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid excluded folder rule: ${rule}`);
  }

  if (segments.some((segment) => UNSUPPORTED_PATTERN.test(segment))) {
    throw new Error(`Unsupported excluded folder rule: ${rule}`);
  }

  return segments.join('/');
}

export function normalizeExcludedFolderRules(rules: string[]): string[] {
  return uniq(
    rules
      .map((rule) => normalizeExcludedFolderRule(rule))
      .filter(Boolean)
  );
}

export function parseExcludedFolderRulesFromEnv(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  return normalizeExcludedFolderRules(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

export function parseExcludedFolderRulesFromSetting(value: string | null): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  try {
    return normalizeExcludedFolderRules(
      value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
  } catch {
    return [];
  }
}

export function serializeExcludedFolderRulesForSetting(rules: string[]): string {
  return normalizeExcludedFolderRules(rules).join('\n');
}

export function getEffectiveExcludedFolderRules({
  envRules = [],
  customRules = []
}: {
  envRules?: string[];
  customRules?: string[];
}): string[] {
  return normalizeExcludedFolderRules([...envRules, ...customRules]);
}

export function matchesExcludedFolder(relativePath: string, rules: string[]): boolean {
  const normalizedRelativePath = normalizeRuleSegments(relativePath).join('/');
  if (normalizedRelativePath.length === 0 || rules.length === 0) {
    return false;
  }

  const segments = splitPathSegments(normalizedRelativePath);

  return rules.some((rule) => {
    if (rule.includes('/')) {
      return isWithinRelativeRoot(normalizedRelativePath, rule);
    }

    return segments.includes(rule);
  });
}
