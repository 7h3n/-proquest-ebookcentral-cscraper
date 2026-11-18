# eBook Scraper

> **Requires Node.js 22:** download it from **https://nodejs.org/en/download** (pick **v22.x**).

A browser extension that saves books from **ProQuest Ebook Central** and **JStor** as PDF. Forked from [janbaykara/ebook-scraper](https://github.com/janbaykara/ebook-scraper).

- **Sites:** Ebook Central (`ebookcentral.proquest.com`, La Trobe and Binghamton proxies), JStor (`www.jstor.org`)
- **Browsers:** Chrome / Chromium-based (Edge, Brave, …), Firefox

## Build

```bash
git clone https://github.com/7h3n/ebookcentral-cscraper.git
cd ebookcentral-cscraper
npm install
npm run build            # Chrome  → .output/chrome-mv3/
npm run build:firefox    # Firefox → .output/firefox-mv2/
```

## Install

**Chrome / Edge / Brave:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select `.output/firefox-mv2/manifest.json`. It is removed when Firefox closes.

After changing the code, run the build again and click **Reload** on the extension.

## Use

1. Log in to your library and open a book.
2. Turn through the pages: each page is captured once it loads.
3. Click the extension icon, then **Download PDF**.

![Popup](screenshot2.png)

- Large books are saved as several files (`<title>_part01_p1-120.pdf`, …) so the browser doesn't run out of memory.
- If a page fails to download (usually an expired library login), the extension stops and saves the pages before it as a PDF. To get the rest: reload the book (log in again if asked), press **Reset** to clear the old, expired captures, turn through the pages again from the failed page, and download. This gives a second PDF; merge the two afterwards.

## License

MIT, see [LICENSE.md](LICENSE.md). Built with [WXT](https://github.com/wxt-dev/wxt) and [jsPDF](https://github.com/parallax/jsPDF).
