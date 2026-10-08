export interface IndexRow {
  template: string;
  platform: string;
  command: string;
  re: RegExp;
  platformRe: RegExp;
}
export const PLATFORMS: Record<string, string[]>;
export function expandIndexCommand(cmd: string): string;
export function loadIndex(dir?: string): IndexRow[];
export function matchIndex(index: IndexRow[], platform: string, command: string): IndexRow | null;
