> **This is Upfly 2,** the Express and Multer upload middleware. It gets security fixes only.
>
> **Upfly 3 is a different tool:** a command-line tool that optimizes the images in a codebase and rewrites the
> references to them, [on GitHub](https://github.com/ramin-010/upfly). `npm i upfly` now installs Upfly 3;
> `npm i upfly@2` keeps Upfly 2, and nothing below changes for it.

<div align="center">

# Upfly

**A stream-based, end-to-end file processing and multi-cloud streaming engine for Node.js.**

Stream, optimize, and distribute files to Cloudinary, AWS S3, or GCS on-the-fly with zero temporary file overhead.

[![npm version](https://img.shields.io/npm/v/upfly.svg?style=flat-square&color=4F46E5)](https://www.npmjs.com/package/upfly)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![CI](https://github.com/ramin-010/upfly/actions/workflows/ci.yml/badge.svg)](https://github.com/ramin-010/upfly/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/upfly.svg?style=flat-square&color=34D399)](https://www.npmjs.com/package/upfly)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178C6?style=flat-square&logo=typescript&logoColor=white)](index.d.ts)

[Website](https://upfly-frontend.vercel.app/) · [Quick Start](https://upfly-frontend.vercel.app/quick-start) · [Cloud Setup](https://upfly-frontend.vercel.app/cloud-setup) · [Error Handling](https://upfly-frontend.vercel.app/error-handling) · [API Reference](https://upfly-frontend.vercel.app/api-reference) · [GitHub](https://github.com/ramin-010/upfly)

</div>

---

## What is Upfly?

Upfly is a production-grade file processing engine and middleware designed for modern Node.js applications. 

Unlike traditional file upload approaches that buffer entire files into memory (causing heap exhaustion) or write unoptimized temp files to disk (cluttering local storage), Upfly processes and streams files **on-the-fly** as chunked streams.

It handles form parsing, format conversion, aggressive image optimization, multi-cloud uploading, and automatic error recovery inside a single, unified, non-blocking pipeline.

### Core Capabilities

- **True Stream-Based Architecture:** Incoming multipart streams are intercepted and processed in small chunks. Files are optimized and uploaded as they are received, keeping your V8 memory footprint extremely low even under heavy upload concurrency.
- **On-the-Fly Optimization:** Powered by Sharp, Upfly dynamically resizes, compresses, and converts images into modern formats (like WebP and AVIF) in a non-blocking worker thread pool.
- **Intelligent Multi-Cloud Streaming:** Stream different fields to different destinations (e.g. avatar images to AWS S3, raw files to disk, thumbnails to Cloudinary) in a single request, using built-in, zero-temp-file cloud adapters.
- **Reliable Failovers (`safeFile`):** An automated backup pipeline monitors the streaming flow. If a network socket drops or image optimization fails, Upfly transparently falls back to saving the original file, guaranteeing zero data loss.

### Example Integration

```javascript
const { upflyUpload } = require('upfly');

app.post('/upload',
  upflyUpload({
    fields: {
      avatar: {
        format: 'webp',
        quality: 80,
        cloudStorage: true,
        cloudProvider: 's3',
        cloudConfig: { region: 'us-east-1', bucket: 'my-bucket', ...credentials }
      }
    },
    safeFile: true // Enable fallback backup pipeline
  }),
  (req, res) => {
    // Upfly handles parsing, optimizing, cloud uploading, and fail-safes.
    res.json({ url: req.files.avatar[0].cloudUrl });
  }
);
```

---


## Highlights

- **Stream-based processing** — files processed in chunks, never fully loaded into memory
- **Image optimization** — Sharp-powered conversion to WebP, AVIF, JPEG, PNG, TIFF, GIF, HEIF
- **Multi-cloud storage** — built-in support for Cloudinary, AWS S3, and Google Cloud Storage
- **Zero data loss** — automatic backup stream with intelligent fallback when `safeFile` is enabled
- **Flexible output** — store to memory, disk, or cloud per field
- **TypeScript support** — full type definitions with conditional cloud config types
- **Multer-compatible** — uses Multer as a peer dependency with a custom storage engine under the hood

---

## Install

```bash
npm install upfly multer
```

> **Requirements:** Node.js >= 18 · Multer is a peer dependency — you must install it alongside upfly.

---

## Quick Start

Convert uploaded images to WebP and store them in memory:

```javascript
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post('/upload',
  upflyUpload({
    fields: {
      images: {
        format: 'webp',
        quality: 80
      }
    }
  }),
  (req, res) => {
    res.json({
      success: true,
      files: req.files.images
    });
  }
);

app.listen(3000);
```

```bash
curl -X POST -F "images=@photo.jpg" http://localhost:3000/upload
```

Your image is automatically converted to WebP at 80% quality. Typical savings: 30–70% file size reduction.

---

## Cloud Upload

Upload directly to Cloudinary with automatic image optimization:

```javascript
app.post('/upload',
  upflyUpload({
    fields: {
      avatar: {
        cloudStorage: true,
        cloudProvider: 'cloudinary',
        cloudConfig: {
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
          folder: 'avatars'
        },
        format: 'webp',
        quality: 85
      }
    },
    limit: 5 * 1024 * 1024,
    safeFile: true
  }),
  (req, res) => {
    res.json({ url: req.files.avatar[0].cloudUrl });
  }
);
```

**Install the Cloudinary SDK:**

```bash
npm install cloudinary
```

**AWS S3** and **Google Cloud Storage** are also supported. Each field can use a different provider. See the [Cloud Setup Guide](https://upfly-frontend.vercel.app/cloud-setup) for full S3 and GCS configuration.

| Provider | Required Package |
|---|---|
| Cloudinary | `npm install cloudinary` |
| AWS S3 | `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage` |
| Google Cloud Storage | `npm install @google-cloud/storage` |

---

## Multi-Field Forms

Different processing rules for each field in a single upload:

```javascript
app.post('/post',
  upflyUpload({
    fields: {
      // Thumbnail: aggressive compression, kept in memory
      thumbnail: {
        format: 'webp',
        quality: 60,
        output: 'memory'
      },

      // Main image: high quality, uploaded to S3
      image: {
        cloudStorage: true,
        cloudProvider: 's3',
        cloudConfig: {
          region: process.env.AWS_REGION,
          bucket: process.env.AWS_BUCKET,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        },
        format: 'webp',
        quality: 85
      },

      // Attachments: no conversion, saved to disk
      attachments: {
        output: 'disk',
        keepOriginal: true
      }
    },
    outputDir: './uploads',
    safeFile: true
  }),
  (req, res) => {
    res.json({
      thumbnail: req.files.thumbnail[0].buffer.toString('base64'),
      imageUrl: req.files.image[0].cloudUrl,
      attachments: req.files.attachments.map(f => f.path)
    });
  }
);
```

---

## Disk Storage

Save files directly to disk without conversion — useful for documents, PDFs, and other non-image uploads:

```javascript
app.post('/documents',
  upflyUpload({
    fields: {
      files: {
        output: 'disk',
        keepOriginal: true
      }
    },
    outputDir: './user-documents',
    limit: 50 * 1024 * 1024  // 50 MB
  }),
  (req, res) => {
    const files = req.files.files.map(f => ({
      path: f.path,
      name: f.originalname,
      size: f.size
    }));
    res.json({ files });
  }
);
```

---

## Conversion-Only Mode

Already using Multer? Use `upflyConvert` to add image conversion to your existing setup without changing your upload logic:

```javascript
const multer = require('multer');
const { upflyConvert } = require('upfly');

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload',
  upload.fields([{ name: 'avatar', maxCount: 1 }]),
  upflyConvert({
    fields: {
      avatar: { format: 'webp', quality: 80, output: 'disk' }
    },
    outputDir: './uploads'
  }),
  (req, res) => {
    res.json({ file: req.files.avatar[0] });
  }
);
```

> `upflyConvert` requires files to be in memory (Multer's `memoryStorage`). It supports memory and disk output, but not cloud storage.

---

## API Reference

### `upflyUpload(options)`

Complete upload + conversion middleware. Handles file interception, processing, and storage.

**Options:**

| Property | Type | Default | Description |
|---|---|---|---|
| `fields` | `Record<string, FieldConfig>` | — | Field configurations keyed by HTML form field name. **Required.** |
| `outputDir` | `string` | `'./uploads'` | Directory for disk output. Field-level `outputDir` takes precedence. |
| `limit` | `number` | `10485760` | Maximum file size in bytes (default: 10 MB). |
| `safeFile` | `boolean` | `false` | Enable automatic backup stream for zero data loss. |

### `upflyConvert(options)`

Conversion-only middleware for files already in `req.file` / `req.files`. Must follow a Multer middleware that uses `memoryStorage()`.

**Options:**

| Property | Type | Default | Description |
|---|---|---|---|
| `fields` | `Record<string, FieldConfig>` | — | Field configurations. **Required.** |
| `outputDir` | `string` | `'./uploads'` | Directory for disk output. |
| `safeFile` | `boolean` | `false` | Enable backup fallback. |

### Field Configuration

Each field in the `fields` object accepts:

| Property | Type | Default | Description |
|---|---|---|---|
| `output` | `'memory' \| 'disk'` | `'memory'` | Where to store the processed file. |
| `outputDir` | `string` | — | Field-specific output directory (overrides global). |
| `format` | `string` | `'webp'` | Target image format. |
| `quality` | `number` | `80` | Compression quality, 1–100. |
| `keepOriginal` | `boolean` | `false` | Skip conversion. Useful for non-image files. |
| `cloudStorage` | `boolean` | `false` | Upload to cloud after processing. |
| `cloudProvider` | `'cloudinary' \| 's3' \| 'gcs'` | — | Cloud provider. Required when `cloudStorage: true`. Aliases: `'aws'` for S3, `'google'` for GCS. |
| `cloudConfig` | `object` | — | Provider-specific configuration. Required when `cloudStorage: true`. See [Cloud Setup Guide](https://upfly-frontend.vercel.app/cloud-setup) for per-provider fields. |

**Supported image formats:**

| | Formats |
|---|---|
| **Input** | JPEG, PNG, WebP, GIF, AVIF, TIFF, SVG, HEIF/HEIC |
| **Output** | WebP, JPEG, PNG, AVIF, TIFF, GIF, HEIF |

### File Result Object

After processing, each file in `req.files.<fieldname>[]` contains:

| Property | Type | Description |
|---|---|---|
| `fieldname` | `string` | Form field name |
| `originalname` | `string` | Original filename |
| `mimetype` | `string` | MIME type |
| `size` | `number` | Final file size in bytes |
| `buffer` | `Buffer` | File data (when `output: 'memory'`) |
| `path` | `string` | File path (when `output: 'disk'`) |
| `cloudUrl` | `string` | Public URL (when `cloudStorage: true`) |
| `cloudPublicId` | `string` | Cloud provider file ID |
| `cloudProvider` | `string` | Provider name |
| `_metadata` | `object` | Error and fallback metadata |

---

## Error Handling

Upfly never crashes your application. When `safeFile: true` is enabled, a backup copy of the original file is maintained during processing. If conversion or upload fails, the backup is used automatically.

All error information is captured in `file._metadata`:

```javascript
const file = req.files.images[0];

if (file._metadata?.isSkipped) {
  // Total failure — file could not be processed at all
  console.error(file._metadata.errors.message);
}

if (file._metadata?.isBackupFallback) {
  // Conversion failed, but the original file was saved successfully
  console.warn('Used backup:', file._metadata.errors.conversion);
}

// file._metadata.isProcessed === true means success
```

The backup system uses smart thresholding: files under 7 MB are backed up in memory; larger files are streamed to a temp directory with automatic cleanup on process exit.

See the [Error Handling Guide](https://upfly-frontend.vercel.app/error-handling) for the full `_metadata` structure and common error scenarios.

---

## Cloud Config Validation

Validate your cloud credentials at application startup:

```javascript
const { validateAllCloudConfigs } = require('upfly/src/cloud');

validateAllCloudConfigs(config.fields)
  .then(() => console.log('Cloud configs validated'))
  .catch(err => console.error('Cloud config error:', err));
```

---

## TypeScript

Upfly ships with full type definitions. Cloud config types are conditional — set `cloudProvider` before `cloudConfig` to get provider-specific autocomplete:

```typescript
import { upflyUpload, UpflyOptions, UpflyFile } from 'upfly';

const options: UpflyOptions = {
  fields: {
    avatar: {
      cloudStorage: true,
      cloudProvider: 'cloudinary',  // Set this first
      cloudConfig: {                // Now you get Cloudinary-specific types
        cloud_name: '...',
        api_key: '...',
        api_secret: '...'
      }
    }
  }
};
```

---

## Upfly for VS Code

If you work with images outside of Express — converting, compressing, or uploading from your editor — check out the **Upfly VS Code Extension**.

- **Right-click convert** — select any image and convert to WebP, AVIF, PNG, or JPEG from the context menu
- **Folder watchers** — automatically convert images dropped into watched directories (recursive)
- **Cloud upload** — convert and upload to Cloudinary, S3, or GCS in one step
- **Compression** — reduce file size without changing format

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ramin.upfly-vscode)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Registry-A60EE5?style=flat-square&logo=eclipseide&logoColor=white)](https://open-vsx.org/extension/ramin/upfly-vscode)

---

## Contributing

Contributions are welcome. Please [open an issue](https://github.com/ramin-010/upfly/issues) before starting work on major changes.

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## License

MIT © [Ramin](https://github.com/ramin-010)

---

<div align="center">

[Website](https://upfly-frontend.vercel.app/) · [Quick Start](https://upfly-frontend.vercel.app/quick-start) · [Cloud Setup](https://upfly-frontend.vercel.app/cloud-setup) · [Error Handling](https://upfly-frontend.vercel.app/error-handling) · [API Reference](https://upfly-frontend.vercel.app/api-reference) · [GitHub](https://github.com/ramin-010/upfly) · [Issues](https://github.com/ramin-010/upfly/issues)

</div>