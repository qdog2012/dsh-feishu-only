/**
 * Preview and original-file download.
 *
 * The reference separates three deliveries that are easy to conflate:
 *  - a **result statement** (text),
 *  - a **preview** (rendered screenshots, never uploaded as an attachment),
 *  - an **original file download** (the bytes themselves).
 *
 * Preview is best-effort and always reports why it failed; it never claims a
 * partial rendering is complete. Web pages are captured through the browser
 * capability when one is registered, Office documents through the Host's
 * conversion service, and plain text renders as an image-free text card.
 *
 * @module dsh-feishu-only/lib/preview
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, basename } from 'node:path';

import { card, clampText, previewCard } from './cards.js';

const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 2000;
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.sh', '.ps1', '.sql', '.toml', '.ini', '.log', '.css', '.scss',
]);

/**
 * What a path can be previewed as, if anything.
 *
 * A missing path, a directory, or an unsupported format yields a precise
 * reason so the caller can say why instead of offering a misleading button.
 */
export function previewKindOf(path) {
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, reason: '没有提供可预览的路径。' };
  }
  if (!isAbsolute(path)) {
    return { ok: false, reason: '只支持预览绝对路径。' };
  }
  if (!existsSync(path)) {
    return { ok: false, reason: '路径不存在。' };
  }
  const extension = extname(path).toLowerCase();
  if (OFFICE_EXTENSIONS.has(extension)) return { ok: true, kind: 'office', extension };
  if (IMAGE_EXTENSIONS.has(extension)) return { ok: true, kind: 'image', extension };
  if (extension === '.pdf') return { ok: true, kind: 'pdf', extension };
  if (TEXT_EXTENSIONS.has(extension)) return { ok: true, kind: 'text', extension };
  return { ok: false, reason: `暂不支持预览 ${extension || '这种'} 格式。` };
}

/**
 * Preview renderer plus original-file downloader.
 */
export class PreviewService {
  #ctx;
  #api;
  #harness;
  #logger;
  #config;
  #inFlight = new Set();

  constructor({ ctx, api, harness, config, logger = console }) {
    this.#ctx = ctx;
    this.#api = api;
    this.#harness = harness;
    this.#config = config;
    this.#logger = logger;
  }

  get #limits() {
    return {
      maxBytes: this.#config.previewMaxBytes ?? MAX_PREVIEW_BYTES,
      timeoutMs: this.#config.previewTimeoutMs ?? 60_000,
    };
  }

  /**
   * Render a preview and send it as a new reply.
   *
   * Repeat presses of the same target are deduplicated: a second press while a
   * rendering is in flight reports progress instead of starting another one.
   */
  async show({ chatId, task, path, downloadId }) {
    const key = `${chatId}:${path}`;
    if (this.#inFlight.has(key)) {
      await this.#api.sendText(chatId, '这个预览正在生成，请稍等。').catch(() => {});
      return;
    }
    this.#inFlight.add(key);
    try {
      const kind = previewKindOf(path);
      if (!kind.ok) {
        await this.#api.sendCard(chatId, previewCard({
          title: '🖼️ 无法预览',
          failed: kind.reason,
          note: '预览与原文件下载是两种不同的交付方式。',
        }));
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        await this.#api.sendCard(chatId, previewCard({
          title: '🖼️ 无法预览',
          failed: '这个路径不是普通文件。',
        }));
        return;
      }
      if (info.size > this.#limits.maxBytes) {
        await this.#api.sendCard(chatId, previewCard({
          title: '🖼️ 文件过大',
          failed: `文件超过 ${Math.round(this.#limits.maxBytes / 1024 / 1024)} MB 的预览上限。`,
          downloadId,
        }));
        return;
      }

      switch (kind.kind) {
        case 'office':
          await this.#showOffice({ chatId, task, path, downloadId });
          return;
        case 'pdf':
          await this.#showPdf({ chatId, task, path, downloadId });
          return;
        case 'image':
          await this.#showImage({ chatId, path, downloadId });
          return;
        case 'text':
          await this.#showText({ chatId, path, downloadId });
          return;
        default:
          await this.#api.sendCard(chatId, previewCard({
            title: '🖼️ 无法预览',
            failed: '不支持的类型。',
          }));
      }
    } catch (error) {
      this.#logger.warn(`[feishu] preview failed: ${error?.message ?? error}`);
      await this.#api.sendCard(chatId, previewCard({
        title: '🖼️ 预览失败',
        failed: error?.message ?? String(error),
        downloadId,
      })).catch(() => {});
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #showOffice({ chatId, task, path, downloadId }) {
    const converter = this.#ctx.get?.('officeToPdf');
    if (!converter?.convert) {
      await this.#api.sendCard(chatId, previewCard({
        title: '🖼️ 无法预览 Office 文档',
        failed: '当前部署没有提供 Office 转换能力。',
        downloadId,
      }));
      return;
    }
    const extension = extname(path).toLowerCase().slice(1);
    const bytes = await readFile(path);
    const result = await converter.convert({
      extension,
      priority: 'foreground',
      source: {
        key: `feishu-preview-${Date.now()}`,
        version: String(await versionOf(path)),
        bytes: bytes.byteLength,
        read: async () => ({ bytes, version: String(bytes.byteLength) }),
      },
    }, AbortSignal.timeout(this.#limits.timeoutMs));

    // The conversion output is a PDF, not a raster: upload it as a `pdf` file
    // so Feishu can page through every page natively. Sending PDF bytes to the
    // image endpoint would be rejected, and rasterizing is not available here —
    // so this never claims to be a screenshot.
    await this.#deliverDocument({
      chatId,
      title: `📄 ${basename(path)}`,
      bytes: result.pdf,
      name: `${basename(path)}.pdf`,
      fileType: 'pdf',
      description: [
        'Office 文档已转换为 PDF，可在飞书中翻阅全部页面。',
        result.missingFonts?.length
          ? `<font color='orange'>缺少字体：${result.missingFonts.join('、')}（排版可能与原文件不同）</font>`
          : null,
        // The conversion is read-only regardless of font substitution, and that
        // promise must survive a missing-font warning rather than replace it.
        '转换不修改原始文件。',
      ].filter(Boolean).join('\n'),
      downloadId,
      note: '这是转换后的 PDF，不是原文件。需要原始文件请使用下载。',
    });
  }

  async #showPdf({ chatId, path, downloadId }) {
    // This deployment has no PDF rasterizer, so the honest preview is the PDF
    // itself: Feishu renders every page natively. Faking a first-page image
    // would violate the rule that a partial view may never be labelled complete.
    const bytes = await readFile(path);
    await this.#deliverDocument({
      chatId,
      title: `📄 ${basename(path)}`,
      bytes,
      name: basename(path),
      fileType: 'pdf',
      description: 'PDF 已按原样发送，可在飞书中翻阅全部页面。',
      downloadId,
      note: '需要落到本地时请使用原文件下载。',
    });
  }

  /**
   * Upload one document as a Feishu file attachment and explain what it is.
   *
   * Kept separate from the image path because a document is not a screenshot:
   * the upload type decides whether Feishu shows a page viewer or a download.
   */
  async #deliverDocument({ chatId, title, bytes, name, fileType, description, downloadId, note }) {
    const fileKey = await this.#api.uploadFile(bytes, { name, fileType }).catch(() => null);
    if (!fileKey) {
      await this.#api.sendCard(chatId, previewCard({
        title,
        failed: '文档上传失败，请稍后重试或直接下载原文件。',
        downloadId,
      }));
      return;
    }
    await this.#api.sendFile(chatId, fileKey);
    await this.#api.sendCard(chatId, previewCard({
      title,
      description,
      messageOnly: true,
      downloadId,
      note,
    }));
  }

  async #showImage({ chatId, path, downloadId }) {
    const bytes = await readFile(path);
    const imageKey = await this.#api.uploadImage(bytes, { name: basename(path), imageType: 'message' });
    // The image itself is the preview, sent as its own message; the card adds
    // the download entry rather than repeating the image inline.
    await this.#api.sendImage(chatId, imageKey);
    await this.#api.sendCard(chatId, previewCard({
      title: `🖼️ ${basename(path)}`,
      description: '图片已作为独立消息发送。',
      messageOnly: true,
      downloadId,
      note: '这是预览；原文件下载是另一项操作。',
    }));
  }

  async #showText({ chatId, path, downloadId }) {
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    const truncated = text.length > MAX_TEXT_PREVIEW_CHARS;
    const body = truncated ? `${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n…` : text;
    await this.#api.sendCard(chatId, card({
      title: `📝 ${basename(path)}`,
      template: 'indigo',
      elements: [
        { tag: 'markdown', content: clampText(body, 3800) },
        {
          tag: 'note',
          elements: [{
            tag: 'plain_text',
            content: truncated
              ? '内容较长，仅显示开头部分；完整内容请下载原文件。预览不执行文件中的活动内容。'
              : '已完整显示。预览不执行文件中的活动内容。',
          }],
        },
      ],
      note: downloadId ? '需要原始文件请使用下载按钮。' : undefined,
    }));
  }

  /**
   * Upload and send the original bytes.
   *
   * Download is an independent capability from preview, and its scope is
   * stated: only paths inside the task workspace are eligible.
   */
  async download({ chatId, task, path }) {
    const kind = previewKindOf(path);
    if (!kind.ok) {
      await this.#api.sendText(chatId, `无法下载：${kind.reason}`).catch(() => {});
      return;
    }
    const workspace = task?.cwd;
    if (workspace && !isInside(path, workspace)) {
      await this.#api.sendText(chatId, '这个路径不在当前任务的工作区内，不能作为附件发送。').catch(() => {});
      return;
    }
    const info = await stat(path);
    if (info.size > (this.#config.downloadMaxBytes ?? 100 * 1024 * 1024)) {
      await this.#api.sendText(chatId, '文件超过下载上限。').catch(() => {});
      return;
    }
    const bytes = await readFile(path);
    const fileKey = await this.#api.uploadFile(bytes, {
      name: basename(path),
      fileType: 'stream',
    });
    await this.#api.sendFile(chatId, fileKey);
  }
}

function isInside(path, root) {
  const normalizedPath = path.replace(/\\/gu, '/').toLowerCase();
  const normalizedRoot = root.replace(/\\/gu, '/').toLowerCase().replace(/\/$/u, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function versionOf(path) {
  try {
    const info = await stat(path);
    return `${info.size}-${Math.floor(info.mtimeMs)}`;
  } catch {
    return '0';
  }
}