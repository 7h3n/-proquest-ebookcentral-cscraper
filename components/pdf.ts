import { jsPDF } from 'jspdf';

import type { Book } from './types';
import type { ImageFormat } from './utils';
import { fetchPageImage, getActiveTab, PageFetchError } from './utils';

/**
 * jsPDF builds the whole document as ONE string, and Chrome caps a string at ~512MB
 * ("RangeError: Invalid string length"). Images are almost all of that size, so a new file is
 * started once the image data stored in the current one reaches this many bytes.
 * The ~360MB of headroom left covers the rest of the PDF structure.
 */
const MAX_IMAGE_BYTES_PER_FILE = 150 * 1024 * 1024;

type StoredImage = { data?: string; sMask?: string };

/**
 * How many bytes of image data jsPDF is holding for this document.
 * Measured from what jsPDF actually stores, because that can be far bigger than the downloaded
 * file (a PNG is decoded and re-encoded), so the size of the download can't be used as a guess.
 */
export function storedImageBytes(pdf: jsPDF): number {
  const collections = (pdf.internal as unknown as { collections?: Record<string, Record<string, StoredImage>> })
    .collections;
  const images = collections?.addImage_images ?? {};
  return Object.values(images).reduce(
    (total, image) => total + (image.data?.length ?? 0) + (image.sMask?.length ?? 0),
    0,
  );
}

/** Add one page image to the document, scaled to fit an A4 page and centred */
export function addImagePage(
  pdf: jsPDF,
  image: { bytes: Uint8Array; format: ImageFormat; width: number; height: number },
  newPage: boolean,
) {
  if (newPage) {
    pdf.addPage();
  }
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const ratio = Math.min(pageWidth / image.width, pageHeight / image.height);
  const scaledWidth = image.width * ratio;
  const scaledHeight = image.height * ratio;
  const offsetX = (pageWidth - scaledWidth) / 2;
  const offsetY = (pageHeight - scaledHeight) / 2;

  // The original file bytes go in directly, so JPEGs are embedded unchanged (no quality loss).
  // 'FAST' matters for PNG: without a compression setting jsPDF stores PNG pages as raw,
  // uncompressed pixels, which is easily 100x bigger than the file and overflows the string limit.
  pdf.addImage(image.bytes, image.format, offsetX, offsetY, scaledWidth, scaledHeight, undefined, 'FAST');
}

export async function createPDF(
  book: Book,
  onProgress?: (percent: number) => void,
  onLog?: (msg: string) => void,
  onError?: (err: string) => void,
  onEstimatedTime?: (time: string | null) => void,
): Promise<jsPDF> {
  try {
    const startTime = Date.now();

    if (!book.pages || book.pages.length === 0) {
      const err = 'No pages to create PDF';
      onError?.(err);
      throw new Error(err);
    }

    // Every captured URL was already checked by its site's testPageImageURL when it was saved
    const imagePages = book.pages;

    const totalPages = imagePages.length;
    let processed = 0;

    // File name (read the tab title up front: parts are saved while the loop is still running)
    const activeTab = await getActiveTab();
    const title = activeTab ? activeTab.title : book.url;

    let pdf = new jsPDF('p', 'pt', 'a4'); // portrait, points, A4 size
    let pagesInFile = 0; // pages actually added to the current file
    let fileIndex = 1;
    let firstPageOfFile = 1; // position (1-based) in the capture list where the current file starts
    let stoppedAtPage: number | null = null; // set when a page can't be downloaded and we give up
    const formatsSeen = new Map<ImageFormat, number>();

    // Save the current file, then start a fresh jsPDF so the finished one can be garbage-collected
    const savePart = async (lastPageOfFile: number) => {
      // The number of files isn't known in advance (it depends on image sizes)
      const isWholeBook = fileIndex === 1 && firstPageOfFile === 1 && lastPageOfFile === totalPages;
      const filename = isWholeBook
        ? `${title}_${totalPages}pages.pdf`
        : `${title}_part${String(fileIndex).padStart(2, '0')}_p${firstPageOfFile}-${lastPageOfFile}.pdf`;

      const megabytes = Math.round(storedImageBytes(pdf) / 1024 / 1024);
      onLog?.(`Saving file ${fileIndex} (${megabytes}MB of images): ${filename}`);
      pdf.save(filename);

      pdf = new jsPDF('p', 'pt', 'a4');
      pagesInFile = 0;
      fileIndex++;
      firstPageOfFile = lastPageOfFile + 1;

      // Small pause so the browser doesn't drop back-to-back downloads
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    for (const pageUrl of imagePages) {
      onLog?.(`Processing page ${processed + 1} of ${totalPages}`);

      try {
        const image = await fetchPageImage(pageUrl);
        formatsSeen.set(image.format, (formatsSeen.get(image.format) ?? 0) + 1);

        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(image.blob);
        } catch {
          throw new Error(`the ${image.format} image is damaged and can't be opened, skipping it`);
        }
        const { width, height } = bitmap;
        bitmap.close();

        addImagePage(pdf, { ...image, width, height }, pagesInFile > 0);
        pagesInFile++;

        // Close this file once it holds enough image data; the next page starts a new one
        if (storedImageBytes(pdf) >= MAX_IMAGE_BYTES_PER_FILE) {
          await savePart(processed + 1);
        }
      } catch (err: unknown) {
        if (err instanceof PageFetchError) {
          // The session has most likely expired, so every later page would fail too.
          // Stop here and still save the pages that were already downloaded.
          stoppedAtPage = processed + 1;
          onLog?.(`Could not download page ${stoppedAtPage} (${err.message}). Stopping.`);
          break;
        }

        const errorMessage = `Error processing page ${processed + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`;

        onLog?.(errorMessage);
        onError?.(errorMessage);
      }

      processed++;

      const percent = Math.round((processed / totalPages) * 100);
      onProgress?.(percent);

      // Time estimate logic
      if (percent > 0 && onEstimatedTime) {
        const elapsed = Date.now() - startTime;
        const estimatedTotal = (elapsed / percent) * 100;
        const remaining = estimatedTotal - elapsed;
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.ceil((remaining % 60000) / 1000);
        onEstimatedTime(`${minutes}m ${seconds}s`);
      }
    }

    if (formatsSeen.size > 0) {
      onLog?.(`Page image formats: ${[...formatsSeen].map(([format, count]) => `${format} x${count}`).join(', ')}`);
    }

    // Save whatever is left (the last, possibly shorter, file)
    if (pagesInFile > 0) {
      await savePart(processed);
    }
    onEstimatedTime?.(null);

    if (stoppedAtPage !== null) {
      const saved = stoppedAtPage > 1 ? `Pages 1-${stoppedAtPage - 1} were saved. ` : 'No pages were saved. ';
      const message =
        `Stopped at page ${stoppedAtPage} of ${totalPages}: it could not be downloaded. ` +
        saved +
        'Your library login has probably expired: reload the book (log in again if asked), ' +
        `press Reset, then capture again from page ${stoppedAtPage}.`;
      onLog?.(message);
      onError?.(message);
      return pdf;
    }

    onLog?.('PDF download complete.');
    return pdf;
  } catch (e: unknown) {
    onEstimatedTime?.(null);
    const message = `Fatal error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    onError?.(message);
    throw e;
  }
}
