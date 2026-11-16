import { jsPDF } from 'jspdf';
import type { Worker, Word } from 'tesseract.js';
import { createWorker } from 'tesseract.js';

import type { Book } from './types';
import { fetchAsBlob, getActiveTab } from './utils';

/**
 * jsPDF builds the whole document as ONE string, and Chrome caps a string at ~512MB
 * ("RangeError: Invalid string length"). Saving a separate file every N pages keeps
 * each document well under that limit.
 */
const PAGES_PER_FILE = 100;

export async function createPDF(
  book: Book,
  onProgress?: (percent: number) => void,
  onLog?: (msg: string) => void,
  onError?: (err: string) => void,
  useOCR = true,
  onEstimatedTime?: (time: string | null) => void,
): Promise<jsPDF> {
  let worker: Worker | null = null;
  let workerUrl: string | null = null;

  try {
    onLog?.('Initialising Tesseract.js.');

    const startTime = Date.now();

    const workerCode = await fetch(chrome.runtime.getURL('tesseract/worker.min.js')).then((res) => res.text());
    const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(workerBlob);

    worker = await createWorker({
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('/tesseract/tesseract-core.wasm.js'),
      langPath: chrome.runtime.getURL('tesseract/'),
      logger: (m) => console.log(m),
      workerBlobURL: false, // Prevents tesseract falling back to external CDN
    });

    await worker.load();
    await worker.loadLanguage('eng');
    await worker.initialize('eng');

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
    const totalFiles = Math.ceil(totalPages / PAGES_PER_FILE);

    let pdf = new jsPDF('p', 'pt', 'a4'); // portrait, points, A4 size
    let pagesInFile = 0; // pages actually added to the current file
    let fileIndex = 1;
    let firstPageOfFile = 1; // position (1-based) in the capture list where the current file starts

    // Save the current file, then start a fresh jsPDF so the finished one can be garbage-collected
    const savePart = async (lastPageOfFile: number) => {
      const filename =
        totalFiles === 1
          ? `${title}_${totalPages}pages.pdf`
          : `${title}_part${String(fileIndex).padStart(2, '0')}of${String(totalFiles).padStart(2, '0')}` +
            `_p${firstPageOfFile}-${lastPageOfFile}.pdf`;

      onLog?.(`Saving file ${fileIndex} of ${totalFiles}: ${filename}`);
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
        const blobURI = await fetchAsBlob(pageUrl);
        const img = new Image();
        img.src = blobURI;

        await new Promise<void>((imgLoadResolve) => {
          let lastBlobUrl: string | null = null;

          img.onload = async () => {
            const imgWidth = img.width;
            const imgHeight = img.height;

            if (pagesInFile > 0) {
              pdf.addPage();
            }
            pagesInFile++;

            // Calculate dimensions to fit the page
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const ratio = Math.min(pageWidth / imgWidth, pageHeight / imgHeight);
            const scaledWidth = imgWidth * ratio;
            const scaledHeight = imgHeight * ratio;

            const offsetX = (pageWidth - scaledWidth) / 2;
            const offsetY = (pageHeight - scaledHeight) / 2;

            pdf.addImage(img, 'JPEG', offsetX, offsetY, scaledWidth, scaledHeight);

            // Perform OCR on image if enabled
            if (useOCR) {
              onLog?.(`OCR page ${processed + 1}`);
              try {
                if (!worker) {
                  throw new Error('Tesseract worker not initialized');
                }
                const { data } = await worker.recognize(img);

                pdf.setFontSize(10);

                data.words.forEach((word: Word) => {
                  const { bbox } = word;
                  const x = offsetX + bbox.x0 * ratio;
                  const y = offsetY + bbox.y1 * ratio; // y1 is the bottom of the line where the highlight should begin
                  pdf.text(word.text, x, y, { renderingMode: 'invisible' });
                });
              } catch (ocrErr) {
                onLog?.(
                  `OCR failed for page ${processed + 1}: ${ocrErr instanceof Error ? ocrErr.message : 'Unknown error'}`,
                );
              }
            }

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

      if (pagesInFile >= PAGES_PER_FILE) {
        await savePart(processed);
      }

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

    onLog?.('PDF generation complete.');
    await worker.terminate();
    URL.revokeObjectURL(workerUrl);
    onLog?.('PDF download complete.');
    onEstimatedTime?.(null);
    return pdf;
  } catch (e: unknown) {
    await worker?.terminate();
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
    }
    onEstimatedTime?.(null);
    const message = `Fatal error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    onError?.(message);
    throw e;
  }
}
