import fs from 'fs';

export const safeLoadJson = <T = any>(path: string): T | undefined => {
  try {
    if (!fs.existsSync(path)) return undefined;
    return JSON.parse(fs.readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
};

export const mdSection = (title: string, body: string) => `## ${title}\n${body.trim()}\n`;

export const bulletList = (items: string[]) =>
  items.length ? items.map((i) => `- ${i}`).join('\n') + '\n' : '_None_\n';

export const defaultFooter = () =>
  '\n\n_Note: Narrative is informational only; trading logic remains deterministic and unchanged._\n';
