export const APP_SCHEMA_VERSION: 1;
export const DEFAULT_CONFIG_FILE: 'natui.app.json';

export interface NatuiAppIconConfig {
  macos?: string;
  windows?: string;
}

export interface NatuiAppConfig {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  buildNumber: string;
  entry: string;
  executable: string;
  output?: string;
  icons?: NatuiAppIconConfig;
}

export interface ResolvedNatuiAppConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  buildNumber: string;
  entry: string;
  executable: string;
  output: string;
  root: string;
  entryPath: string;
  outputPath: string;
  icons: NatuiAppIconConfig;
}

export function validateAppConfig(
  value: unknown,
  configDirectory?: string,
  configFile?: string,
): ResolvedNatuiAppConfig;

export function loadAppConfig(
  configPath?: string,
  options?: { allowMissing?: false },
): Promise<ResolvedNatuiAppConfig>;

export function loadAppConfig(
  configPath: string | undefined,
  options: { allowMissing: true },
): Promise<ResolvedNatuiAppConfig | undefined>;

export function loadAppConfig(
  configPath: string | undefined,
  options: { allowMissing?: boolean },
): Promise<ResolvedNatuiAppConfig | undefined>;
