import { marked } from "marked";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

type Frontmatter = {
  title?: string;
  date?: string;
  summary?: string;
  tags?: string;
  layout?: string;
};

type Post = {
  title: string;
  date: string;
  summary: string;
  slug: string;
  tags: string[];
  layout: string;
};

const markdownRenderer = new marked.Renderer();
markdownRenderer.image = (href, title, text) => {
  const safeHref = href ?? "";
  const safeAlt = text ?? "";
  const titleAttr = title ? ` title="${title}"` : "";
  return `<img src="${safeHref}" alt="${safeAlt}" class="post-image"${titleAttr} />`;
};

marked.use({ renderer: markdownRenderer });

const SITE_TITLE = "Tristan Jet's Blog";

const CONTENT_DIR = "content";
const LAYOUT_DIR = "layouts";
const DIST_DIR = "public";
const ASSETS_DIR = "assets";

const BASE_LAYOUT = "base.html";
const DEFAULT_LAYOUT = "post.html";
const INDEX_LAYOUT = "index.html";
const BLOG_LAYOUT = "blog.html";
const CONTACT_LAYOUT = "contact.html";

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const text = stripBom(raw);
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    return { frontmatter: {}, body: text };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n");
  const frontmatter: Frontmatter = {};

  for (const line of frontmatterLines) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    frontmatter[key as keyof Frontmatter] = value;
  }

  return { frontmatter, body };
}

function slugFromFilename(filePath: string): string {
  return basename(filePath, extname(filePath)).trim();
}

function fillTemplate(template: string, data: Record<string, string>): string {
  return template.replace(TOKEN_RE, (_, key: string) => {
    return data[key] ?? "";
  });
}

function sortByDateDesc(a: Post, b: Post): number {
  const dateA = Date.parse(a.date);
  const dateB = Date.parse(b.date);
  if (Number.isNaN(dateA) && Number.isNaN(dateB)) return a.title.localeCompare(b.title);
  if (Number.isNaN(dateA)) return 1;
  if (Number.isNaN(dateB)) return -1;
  return dateB - dateA;
}

type BlockSpec = {
  name: string;
  startMarker: string;
  endMarker: string;
};

function extractBlocks(
  template: string,
  specs: BlockSpec[],
): { pageTemplate: string; blockTemplates: Record<string, string> } {
  let pageTemplate = template;
  const blockTemplates: Record<string, string> = {};

  for (const spec of specs) {
    const startIndex = pageTemplate.indexOf(spec.startMarker);
    const endIndex = pageTemplate.indexOf(spec.endMarker);
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      throw new Error(`Missing block markers: ${spec.startMarker} ... ${spec.endMarker}`);
    }

    const blockStart = startIndex + spec.startMarker.length;
    blockTemplates[spec.name] = pageTemplate.slice(blockStart, endIndex).trim();
    pageTemplate =
      pageTemplate.slice(0, startIndex) + `{{${spec.name}}}` + pageTemplate.slice(endIndex + spec.endMarker.length);
  }

  return { pageTemplate, blockTemplates };
}

function requireBlockTemplate(
  blocks: { blockTemplates: Record<string, string> },
  name: string,
): string {
  const template = blocks.blockTemplates[name];
  if (!template) {
    throw new Error(`Missing block template: ${name}`);
  }
  return template;
}

function formatDate(value: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(parsed));
}

function formatDateDdMmYyyy(value: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const date = new Date(parsed);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}-${month}-${year}`;
}

function parseTags(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function applyShortcodes(markdown: string): string {
  return markdown.replace(/::video\[(.+?)\]/g, (_, src: string) => {
    const trimmed = src.trim();
    if (!trimmed) return "";
    const extension = trimmed.split(".").pop()?.toLowerCase() ?? "";
    const typeMap: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      ogg: "video/ogg",
    };
    const type = typeMap[extension] ?? "video/mp4";
    return `<video controls autoplay="false" preload="metadata" class="post-video">\n  <source src="${trimmed}" type="${type}" />\n  Your browser does not support the video tag.\n</video>`;
  });
}

async function ensureDir(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

async function copyAssets(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = (await readdir(ASSETS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const file = Bun.file(join(ASSETS_DIR, entry));
    await Bun.write(join(DIST_DIR, entry), file);
  }

  const mediaDir = join(ASSETS_DIR, "media");
  let mediaEntries: string[] = [];
  try {
    mediaEntries = (await readdir(mediaDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    mediaEntries = [];
  }

  if (mediaEntries.length > 0) {
    const mediaOutDir = join(DIST_DIR, "media");
    await ensureDir(mediaOutDir);
    for (const entry of mediaEntries) {
      const file = Bun.file(join(mediaDir, entry));
      await Bun.write(join(mediaOutDir, entry), file);
    }
  }
}

async function loadLayout(name: string): Promise<string> {
  const layoutPath = join(LAYOUT_DIR, name);
  const layoutFile = Bun.file(layoutPath);
  if (!(await layoutFile.exists())) {
    throw new Error(`Missing layout: ${layoutPath}`);
  }
  return await layoutFile.text();
}

async function loadMarkdown(filePath: string): Promise<{ frontmatter: Frontmatter; contentHtml: string }> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return { frontmatter: {}, contentHtml: "" };
  }

  const raw = await file.text();
  const { frontmatter, body } = parseFrontmatter(raw);
  const contentHtml = await marked.parse(applyShortcodes(body));
  return { frontmatter, contentHtml };
}

async function build(): Promise<void> {
  await ensureDir(DIST_DIR);
  await copyAssets();

  const baseLayout = await loadLayout(BASE_LAYOUT);
  const indexLayout = await loadLayout(INDEX_LAYOUT);
  const blogLayout = await loadLayout(BLOG_LAYOUT);
  const contactLayout = await loadLayout(CONTACT_LAYOUT);
  const defaultPostLayout = await loadLayout(DEFAULT_LAYOUT);

  const homeMarkdown = await loadMarkdown(join(CONTENT_DIR, "index.md"));
  const blogMarkdown = await loadMarkdown(join(CONTENT_DIR, "blog", "index.md"));

  const blogDirPath = join(CONTENT_DIR, "blog");
  let markdownFiles: string[] = [];
  try {
    const entries = await readdir(blogDirPath, { withFileTypes: true });
    markdownFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
      .map((entry) => join(blogDirPath, entry.name));
  } catch {
    markdownFiles = [];
  }

  const posts: Post[] = [];

  for (const filePath of markdownFiles) {
    const { frontmatter, contentHtml } = await loadMarkdown(filePath);
    const slug = slugFromFilename(filePath);
    const title = frontmatter.title?.trim() || slug.replace(/-/g, " ");
    const date = frontmatter.date?.trim() || "";
    const summary = frontmatter.summary?.trim() || "";
    const tags = parseTags(frontmatter.tags);
    const layoutName = frontmatter.layout?.trim() || DEFAULT_LAYOUT;

    const postLayout = layoutName === DEFAULT_LAYOUT ? defaultPostLayout : await loadLayout(layoutName);
    const postPartial = fillTemplate(postLayout, {
      title,
      date: formatDate(date),
      summary,
      slug,
      content: contentHtml,
      "site-title": SITE_TITLE,
    });

    const pageHtml = fillTemplate(baseLayout, {
      "site-title": SITE_TITLE,
      page: postPartial,
    });

    const postDir = join(DIST_DIR, "blog", slug);
    await ensureDir(postDir);
    await Bun.write(join(postDir, "index.html"), pageHtml);

    posts.push({
      title,
      date,
      summary,
      slug,
      tags,
      layout: layoutName,
    });
  }

  posts.sort(sortByDateDesc);

  const blogBlocks = extractBlocks(blogLayout, [
    {
      name: "blog-items",
      startMarker: "<!-- BLOG_ITEM -->",
      endMarker: "<!-- /BLOG_ITEM -->",
    },
  ]);

  const blogItemTemplate = requireBlockTemplate(blogBlocks, "blog-items");
  const listHtml = posts
    .map((post) => {
      return fillTemplate(blogItemTemplate, {
        title: post.title,
        date: formatDate(post.date),
        summary: post.summary,
        slug: encodeURIComponent(post.slug),
      });
    })
    .join("\n");

  const blogPartial = fillTemplate(blogBlocks.pageTemplate, {
    "blog-items": listHtml,
    content: blogMarkdown.contentHtml,
    "site-title": SITE_TITLE,
  });

  const blogPage = fillTemplate(baseLayout, {
    "site-title": SITE_TITLE,
    page: blogPartial,
  });

  const blogDir = join(DIST_DIR, "blog");
  await ensureDir(blogDir);
  await Bun.write(join(blogDir, "index.html"), blogPage);

  const contactPartial = fillTemplate(contactLayout, {
    "site-title": SITE_TITLE,
  });

  const contactPage = fillTemplate(baseLayout, {
    "site-title": SITE_TITLE,
    page: contactPartial,
  });

  const contactDir = join(DIST_DIR, "contact");
  await ensureDir(contactDir);
  await Bun.write(join(contactDir, "index.html"), contactPage);

  const indexBlocks = extractBlocks(indexLayout, [
    {
      name: "writing-items",
      startMarker: "<!-- WRITING_ITEM -->",
      endMarker: "<!-- /WRITING_ITEM -->",
    },
    {
      name: "project-items",
      startMarker: "<!-- PROJECT_ITEM -->",
      endMarker: "<!-- /PROJECT_ITEM -->",
    },
  ]);

  const writingItemTemplate = requireBlockTemplate(indexBlocks, "writing-items");
  const projectItemTemplate = requireBlockTemplate(indexBlocks, "project-items");

  const writingItems = posts
    .filter((post) => post.tags.includes("writing"))
    .map((post) => {
      return fillTemplate(writingItemTemplate, {
        title: post.title,
        date: formatDateDdMmYyyy(post.date),
        summary: post.summary,
        slug: encodeURIComponent(post.slug),
      });
    })
    .join("\n");

  const projectItems = posts
    .filter((post) => post.tags.includes("projects"))
    .map((post) => {
      return fillTemplate(projectItemTemplate, {
        title: post.title,
        date: formatDateDdMmYyyy(post.date),
        summary: post.summary,
        slug: encodeURIComponent(post.slug),
      });
    })
    .join("\n");

  const indexPartial = fillTemplate(indexBlocks.pageTemplate, {
    content: homeMarkdown.contentHtml,
    "writing-items": writingItems,
    "project-items": projectItems,
    "site-title": SITE_TITLE,
  });

  const indexPage = fillTemplate(baseLayout, {
    "site-title": SITE_TITLE,
    page: indexPartial,
  });

  await Bun.write(join(DIST_DIR, "index.html"), indexPage);

  console.log(`Built ${posts.length} post(s) to ${DIST_DIR}/`);
}

function resolvePathFromUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "") {
    return join(DIST_DIR, "index.html");
  }

  const requested = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const requestedPath = requested.endsWith("/") ? requested.slice(0, -1) : requested;

  if (requestedPath.includes(".")) {
    return join(DIST_DIR, requestedPath);
  }

  return join(DIST_DIR, requestedPath, "index.html");
}

async function serve(port = 3000): Promise<void> {
  Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const filePath = resolvePathFromUrl(url);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        return new Response(file);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`Serving ${DIST_DIR}/ at http://localhost:${port}`);
}

if (Bun.argv.includes("serve")) {
  await serve();
} else {
  await build();
}
