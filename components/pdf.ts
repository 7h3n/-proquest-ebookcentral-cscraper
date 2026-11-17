import { jsPDF } from 'jspdf';

import type { Book } from './types';
import { fetchAsBlob, getActiveTab } from './utils';

/**
 * jsPDF builds the whole document as ONE string, and Chrome caps a string at ~512MB
 * ("RangeError: Invalid string length"). Images are almost all of that size, so a new file is
 * started once the images already in the current one reach this many bytes. Splitting by
 * page count doesn't work: zoomed-in pages are much bigger images than normal ones.
 * The ~360MB of headroom left covers the rest of the PDF structure.
 */
const MAX_IMAGE_BYTES_PER_FILE = 150 * 1024 * 1024;

/** Byte size of the data behind a base64 data URL, without decoding it */
const dataURLBytes = (dataURL: string) => Math.floor(((dataURL.length - dataURL.indexOf(',') - 1) * 3) / 4);

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

    // Filter out non-image URLs
    const imagePages = book.pages.filter((url) => url.includes('/docImage.action') && url.includes('encrypted='));

    if (imagePages.length === 0) {
      const errorMessage = 'No valid image pages found';
      onError?.(errorMessage);
      throw new Error(errorMessage);
    }

    const totalPages = imagePages.length;
    let processed = 0;

    // File name (read the tab title up front: parts are saved while the loop is still running)
    const activeTab = await getActiveTab();
    const title = activeTab ? activeTab.title : book.url;

    let pdf = new jsPDF('p', 'pt', 'a4'); // portrait, points, A4 size
    let pagesInFile = 0; // pages actually added to the current file
    let bytesInFile = 0; // image bytes already in the current file
    let fileIndex = 1;
    let firstPageOfFile = 1; // position (1-based) in the capture list where the current file starts

    // Save the current file, then start a fresh jsPDF so the finished one can be garbage-collected
    const savePart = async (lastPageOfFile: number) => {
      // The number of files isn't known in advance any more (it depends on image sizes)
      const isWholeBook = fileIndex === 1 && firstPageOfFile === 1 && lastPageOfFile === totalPages;
      const filename = isWholeBook
        ? `${title}_${totalPages}pages.pdf`
        : `${title}_part${String(fileIndex).padStart(2, '0')}_p${firstPageOfFile}-${lastPageOfFile}.pdf`;

      onLog?.(`Saving file ${fileIndex} (${Math.round(bytesInFile / 1024 / 1024)}MB of images): ${filename}`);
      pdf.save(filename);

      pdf = new jsPDF('p', 'pt', 'a4');
      pagesInFile = 0;
      bytesInFile = 0;
      fileIndex++;
      firstPageOfFile = lastPageOfFile + 1;

      // Small pause so the browser doesn't drop back-to-back downloads
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    for (const pageUrl of imagePages) {
      onLog?.(`Processing page ${processed + 1} of ${totalPages}`);

      try {
        const blobURI = await fetchAsBlob(pageUrl);
        const pageBytes = dataURLBytes(blobURI);

        // Close the current file first if this page would push it over the size budget
        if (pagesInFile > 0 && bytesInFile + pageBytes > MAX_IMAGE_BYTES_PER_FILE) {
          await savePart(processed);
        }
        const img = new Image();
        img.src = blobURI;

        await new Promise<void>((imgLoadResolve) => {
          let lastBlobUrl: string | null = null;

          img.onload = () => {
            const imgWidth = img.width;
            const imgHeight = img.height;

            if (pagesInFile > 0) {
              pdf.addPage();
            }
            pagesInFile++;
            bytesInFile += pageBytes;

            // Calculate dimensions to fit the page
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const ratio = Math.min(pageWidth / imgWidth, pageHeight / imgHeight);
            const scaledWidth = imgWidth * ratio;
            const scaledHeight = imgHeight * ratio;

            const offsetX = (pageWidth - scaledWidth) / 2;
            const offsetY = (pageHeight - scaledHeight) / 2;

            pdf.addImage(img, 'JPEG', offsetX, offsetY, scaledWidth, scaledHeight);

            //Free blobs after images are added to prevent memory overload
            //Queue last cycle's blob otherwise errors are thrown
            if (lastBlobUrl) {
              URL.revokeObjectURL(lastBlobUrl);
            }
            lastBlobUrl = img.src;

            imgLoadResolve();
          };
          img.onerror = () => {
            const err = `Failed to load image: ${pageUrl}`;
            onLog?.(err);
            onError?.(err);
            imgLoadResolve();
          };
        });
      } catch (err: unknown) {
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

    // Save whatever is left (the last, possibly shorter, file)
    if (pagesInFile > 0) {
      await savePart(processed);
    }

    onLog?.('PDF download complete.');
    onEstimatedTime?.(null);
    return pdf;
  } catch (e: unknown) {
    onEstimatedTime?.(null);
    const message = `Fatal error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    onError?.(message);
    throw e;
  }
}
