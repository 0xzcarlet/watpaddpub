export interface Part {
  id: string;
  title: string;
  url: string;
  modified?: string;
}
export interface Story {
  id: string;
  title: string;
  author: string;
  description: string;
  language: string;
  url: string;
  cover?: string;
  modified?: string;
  parts: Part[];
}
export interface Chapter { id: string; title: string; html: string }
export interface Asset { name: string; mime: string; data: Uint8Array }
export type Log = (message: string) => void;
export class DownloadError extends Error {
  constructor(message: string, public retryable = false, public retryAfter = 0) {
    super(message); this.name = 'DownloadError';
  }
}
