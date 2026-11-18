import sites from './sites';
import type { Book, LocalStorageData } from './types';

export function getActiveTab(): Promise<false | Browser.tabs.Tab> {
  return new Promise((resolve) => {
    browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) {
        return resolve(false);
      }
      return resolve(tabs[0]);
    });
  });
}

export async function getURL(): Promise<false | URL> {
  const tab = await getActiveTab();
  return tab && tab.url ? new URL(tab.url) : false;
}

export function getBookURL(url: URL): string | undefined {
  const site = sites.find((site) => site.host === url.host);

  if (site) {
    return site.constructBookURL(url);
  }
  return undefined;
}

/**
 * Determines whether a URL is a page image
 * @param path
 */
export function extractPageImageURL(request: Browser.webRequest.WebRequestDetails): string | null {
  const url = new URL(request.url);

  const site = sites.find((site) => site.testPageImageURL(request, url));

  if (site) {
    return site.getPageImageURL(url);
  }

  return null;
}

export const getBook = (url: string): Promise<Book | null> =>
  new Promise((resolve) => {
    browser.storage.local.get<LocalStorageData>(url, (store?: LocalStorageData) => {
      const book = store?.[url];
      if (book) {
        return resolve(book);
      }
      return resolve(null);
    });
  });

/**
 * A page image could not be downloaded at all (network error, HTTP error, or a web page came back
 * instead of an image). With a library proxy this almost always means the login session expired,
 * so every page after it will fail too.
 */
export class PageFetchError extends Error {}

export type ImageFormat = 'JPEG' | 'PNG' | 'GIF' | 'WEBP';

/** Work out the real image format from the first bytes (don't trust the Content-Type header) */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'JPEG';
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
    return 'PNG';
  }
  if (startsWith(0x47, 0x49, 0x46, 0x38)) {
    return 'GIF';
  }
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) {
    return 'WEBP';
  }
  return null;
}

export type PageImage = {
  blob: Blob;
  bytes: Uint8Array;
  format: ImageFormat;
};

/**
 * Download one page image. Throws PageFetchError when the page can't be downloaded or the server
 * sends back something that isn't an image (an error or login page): later pages would fail too.
 */
export async function fetchPageImage(path: string): Promise<PageImage> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch (err) {
    // "Failed to fetch": e.g. the proxy redirected to its login page, which the extension can't read
    throw new PageFetchError(err instanceof Error ? err.message : 'Failed to fetch');
  }
  if (!res.ok) {
    throw new PageFetchError(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const format = sniffImageFormat(bytes);
  if (!format) {
    throw new PageFetchError(
      `The server sent something that isn't an image (${blob.type || 'unknown type'}, ${bytes.byteLength} bytes)`,
    );
  }
  return { blob, bytes, format };
}

/**
 * @param array
 * @param from Starting index
 * @param to Finishing index
 * @param on How many elements to move from 'from' (starting index)
 */
export function move<T extends string[]>(array: T, from: number, to: number, on = 1): T {
  array.splice(to, 0, ...array.splice(from, on));
  return array;
}
