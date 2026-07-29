# Third-Party Licenses

This project includes code from the following third-party packages. Full license texts will be inlined before the first npm publish.

## @svar-ui/react-gantt

**Package:** `@svar-ui/react-gantt` ^2.6.1
**License:** MIT License
**Source:** https://github.com/svar-widgets/gantt

> Note: The full MIT license text and copyright notice for `@svar-ui/react-gantt` will be inlined here manually before the v0.1 npm publish, per ADR-004 attribution requirements.

## html-to-image

**Package:** `html-to-image` ^1.11.13
**License:** MIT License
**Source:** https://github.com/bubkoo/html-to-image

Used internally by `construction-gantt/export` to capture the rendered Gantt as a PNG.

## jsPDF

**Package:** `jspdf` ^4.2.1
**License:** MIT License
**Source:** https://github.com/parallax/jsPDF

Used internally by `construction-gantt/export` to embed the captured PNG in a PDF page.

## ExcelJS

**Package:** `exceljs` ^4.4.0
**License:** MIT License
**Source:** https://github.com/exceljs/exceljs

Used internally by `construction-gantt/export` to write the project's task data to `.xlsx`. Replaced the SheetJS `xlsx` package, whose npm distribution is frozen at 0.18.5 and carries unpatched (parse-path) advisories; ExcelJS is MIT-licensed and actively maintained.

## fast-xml-parser

**Package:** `fast-xml-parser` ^4.5.6
**License:** MIT License
**Source:** https://github.com/NaturalIntelligence/fast-xml-parser

Used internally by `construction-gantt`'s MSPDI XML interop (`parseMspdi`, `serializeMspdi`) for reading and writing MS Project Data Interchange documents.
