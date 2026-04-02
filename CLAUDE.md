# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CV Anonymizer is a client-side-only web application for redacting/anonymizing CV documents (PDF and DOCX). All processing happens in the browser — no server, no build system, no package manager.

## Running

Open `index.html` directly in a browser or serve with any static file server (e.g., `npx serve .` or VS Code Live Server). There is no build step, no transpilation, and no dependencies to install.

## Architecture

Three files make up the entire application:

- **index.html** — Markup and CDN script imports (pdf.js, mammoth.js, jsPDF, html2pdf)
- **app.js** — All application logic in vanilla JS (no framework)
- **style.css** — Dark-themed UI with CSS custom properties

### Key Data Flow

1. **File upload** → drag-drop or file picker (`handleFiles`)
2. **Document processing** → PDF path uses pdf.js to render pages to canvas + transparent text overlay layer; DOCX path uses mammoth.js to convert to HTML
3. **Redaction** → User selects text, chooses "Blacken" or "Remove". PDF redactions are absolutely-positioned overlay divs on the page wrapper. DOCX redactions wrap selected text in styled `<span>` elements.
4. **Export** → PDF mode: draws redaction rectangles onto canvas copies, assembles with jsPDF. DOCX mode: clones the DOM, applies redaction styles, converts to PDF via html2pdf.

### State

Global variables manage all state — `currentMode` (pdf/docx), `redactionHistory` (array of redaction entries with undo support), `pdfPageCanvases` (references to rendered canvases for export).

### RTL/Bidi Support

Auto-detects Hebrew (U+0590–U+05FF) and Arabic (U+0600–U+06FF) text to set document direction. Manual LTR/RTL toggle in header. Individual PDF text spans also get `dir="rtl"` when they contain RTL characters.

## CDN Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| pdf.js | 3.11.174 | PDF parsing and canvas rendering |
| mammoth.js | 1.6.0 | DOCX to HTML conversion |
| jsPDF | 2.5.1 | PDF generation for export |
| html2pdf | 0.10.1 | HTML-to-PDF export for DOCX files |

## Notes

- No test framework or linting is configured.
- XSS protection: `escHtml()` sanitizes user-facing text in the redaction sidebar.
- PDF text layer uses transparent-colored spans over the canvas for text selection while keeping the original rendering intact.
