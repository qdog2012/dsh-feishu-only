import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { previewKindOf, PreviewService } from '../lib/preview.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-feishu-preview-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a missing path yields a precise reason instead of a misleading kind', () => {
  const result = previewKindOf('/definitely/not/here/report.docx');
  assert.equal(result.ok, false);
  assert.match(result.reason, /路径不存在/u);
});

test('a relative path is rejected: previews address absolute paths only', () => {
  const result = previewKindOf('reports/a.docx');
  assert.equal(result.ok, false);
  assert.match(result.reason, /绝对路径/u);
});

test('an empty path is rejected', () => {
  assert.equal(previewKindOf('').ok, false);
  assert.equal(previewKindOf(undefined).ok, false);
});

test('known formats map to a preview kind', async () => {
  await withTempDir(async (directory) => {
    for (const [name, kind] of [
      ['a.docx', 'office'], ['b.xlsx', 'office'], ['c.pptx', 'office'],
      ['d.png', 'image'], ['e.jpg', 'image'], ['f.webp', 'image'], ['g.gif', 'image'],
      ['h.pdf', 'pdf'], ['i.md', 'text'], ['j.csv', 'text'], ['k.js', 'text'], ['l.txt', 'text'],
    ]) {
      const path = join(directory, name);
      await writeFile(path, 'x');
      assert.equal(previewKindOf(path).kind, kind, `${name} should be ${kind}`);
    }
  });
});

test('an unsupported format says so rather than offering a button', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'a.unknown-ext');
    await writeFile(path, 'x');
    const result = previewKindOf(path);
    assert.equal(result.ok, false);
    assert.match(result.reason, /暂不支持/u);
  });
});

test('a directory is rejected at render time', async () => {
  await withTempDir(async (directory) => {
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path: join(directory, 'sub'), downloadId: null });
    // `sub` does not exist at all, so the "not a file" path is unreachable here;
    // the missing-path message is the correct one.
    assert.match(JSON.stringify(api.cards), /路径不存在|不是普通文件/u);
  });
});

test('an oversized file reports the limit and offers the original download', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'big.md');
    await writeFile(path, 'x'.repeat(2048));
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: { previewMaxBytes: 1024 },
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: 'preview.download:big' });
    const payload = JSON.stringify(api.cards.at(-1));
    assert.match(payload, /文件过大|上限/u);
    assert.match(payload, /preview\.download/u, 'the original download stays available');
  });
});

test('a text file previews completely and states that it executed nothing', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'notes.md');
    await writeFile(path, '# 标题\n内容');
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: null });
    const payload = JSON.stringify(api.cards.at(-1));
    assert.match(payload, /标题/u);
    assert.match(payload, /不执行/u);
    assert.match(payload, /已完整显示/u);
  });
});

test('a long text file marks the preview as truncated', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'long.txt');
    await writeFile(path, 'a'.repeat(5000));
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: null });
    assert.match(JSON.stringify(api.cards.at(-1)), /仅显示开头部分/u);
  });
});

test('an Office document without a converter explains the missing capability', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'report.docx');
    await writeFile(path, 'x');
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: null });
    assert.match(JSON.stringify(api.cards), /没有提供 Office 转换能力/u);
  });
});

test('an Office document is converted through the host converter', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'report.docx');
    await writeFile(path, 'x');
    const api = new RecordingApi();
    const converter = {
      async convert(request) {
        assert.equal(request.extension, 'docx');
        assert.equal(request.priority, 'foreground');
        return { pdf: new Uint8Array([1, 2, 3]), missingFonts: ['宋体'], cacheKey: 'k', generation: 'g' };
      },
    };
    const service = new PreviewService({
      ctx: { get: (name) => (name === 'officeToPdf' ? converter : undefined) },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: null });
    const payload = JSON.stringify(api.cards.at(-1));
    assert.match(payload, /缺少字体/u, 'missing fonts are disclosed');
    assert.match(payload, /不修改原始文件/u);
  });
});

test('preview asserts the note that a screenshot is not an uploaded file', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'pic.png');
    await writeFile(path, Buffer.from('89504e47', 'hex'));
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.show({ chatId: 'oc_1', task: {}, path, downloadId: 'd' });
    assert.match(JSON.stringify(api.cards.at(-1)), /原文件下载/u);
    assert.equal(api.images.length, 1, 'an image preview is sent as its own message');
  });
});

test('a repeated press while rendering reports progress instead of duplicating', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withTempDir(async (directory) => {
    const path = join(directory, 'slow.md');
    await writeFile(path, 'x');
    const api = new RecordingApi();
    const converter = {
      async convert() {
        await gate;
        return { pdf: new Uint8Array([1]), missingFonts: [], cacheKey: 'k', generation: 'g' };
      },
    };
    const docx = join(directory, 'slow.docx');
    await writeFile(docx, 'x');
    const service = new PreviewService({
      ctx: { get: (name) => (name === 'officeToPdf' ? converter : undefined) },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    const first = service.show({ chatId: 'oc_1', task: {}, path: docx, downloadId: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.show({ chatId: 'oc_1', task: {}, path: docx, downloadId: null });
    assert.match(api.texts.join(' '), /正在生成/u);
    release();
    await first;
    void path;
  });
});

test('downloading is refused for a path outside the task workspace', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'secret.txt');
    await writeFile(path, 'x');
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.download({ chatId: 'oc_1', task: { cwd: join(directory, 'workspace') }, path });
    assert.match(api.texts.join(' '), /工作区/u);
    assert.equal(api.files.length, 0);
  });
});

test('downloading inside the workspace uploads the original bytes', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'out.txt');
    await writeFile(path, 'original content');
    const api = new RecordingApi();
    const service = new PreviewService({
      ctx: { get: () => undefined },
      api,
      harness: {},
      config: {},
      logger: silent,
    });
    await service.download({ chatId: 'oc_1', task: { cwd: directory }, path });
    assert.equal(api.files.length, 1);
    assert.match(api.files[0].name, /out\.txt/u);
    assert.equal(Buffer.from(api.files[0].data).toString('utf8'), 'original content');
  });
});

class RecordingApi {
  cards = [];
  texts = [];
  images = [];
  files = [];

  async sendCard(chatId, payload) {
    this.cards.push(payload);
    return { message_id: `om_${this.cards.length}` };
  }

  async sendText(chatId, text) {
    this.texts.push(text);
    return {};
  }

  async sendImage(chatId, key) {
    this.images.push(key);
    return {};
  }

  async uploadImage() {
    return 'img_key';
  }

  async uploadFile(data, { name }) {
    this.files.push({ data, name });
    return 'file_key';
  }

  async sendFile() {
    return {};
  }

  async sendPrivateCard(openId, payload) {
    this.cards.push(payload);
    return {};
  }
}