const fs = require("fs");
const path = require("path");
const config = require("./configLoader");
const { marked } = require("marked");
const { sendError } = require("./errorHandler");

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function sanitizeUrl(value, allowDataImages = false) {
  const url = String(value || "").trim();
  if (!url) return "";
  const compact = url
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
  const firstDelimiter = compact.search(/[/?#]/);
  const prefix =
    firstDelimiter === -1 ? compact : compact.slice(0, firstDelimiter);
  if (prefix.includes("&") || prefix.includes("\\")) return "";
  const schemeMatch = compact.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) return url;
  const scheme = schemeMatch[1];
  if (allowDataImages && scheme === "data") {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(url)
      ? url
      : "";
  }
  const allowedSchemes = allowDataImages
    ? new Set(["http", "https"])
    : new Set(["http", "https", "mailto", "tel"]);
  if (!allowedSchemes.has(scheme)) return "";
  return url;
}

class MarkdownRenderer {
  constructor(templatePath) {
    this.templatePath = templatePath;
    this.template = null;
  }

  async loadTemplate() {
    if (!this.template) {
      this.template = await fs.promises.readFile(this.templatePath, "utf-8");
    }
    return this.template;
  }

  async render(markdownContent, fileName = "") {
    const renderer = new marked.Renderer();
    const defaultLink = renderer.link.bind(renderer);
    const defaultImage = renderer.image.bind(renderer);
    renderer.html = (html) => escapeHtml(html);
    renderer.link = (href, title, text) => {
      const safeHref = sanitizeUrl(href);
      return safeHref ? defaultLink(safeHref, title, text) : text;
    };
    renderer.image = (href, title, text) => {
      const safeHref = sanitizeUrl(href, true);
      return safeHref ? defaultImage(safeHref, title, text) : escapeHtml(text);
    };
    const htmlContent = marked.parse(markdownContent, { renderer });
    const template = await this.loadTemplate();
    const title = fileName;
    const year = new Date().getFullYear();
    const result = template
      .replace(/\$\{projectName\}/g, config.projectName)
      .replace(/\$\{title\}/g, title)
      .replace(/\$\{htmlContent\}/g, htmlContent)
      .replace(/\$\{year\}/g, year);

    return result;
  }
}

async function serveMarkdown(res, filePath, renderer) {
  try {
    const markdownContent = await fs.promises.readFile(filePath, "utf-8");
    const fileName = path.basename(filePath);
    const html = await renderer.render(markdownContent, fileName);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return sendError(res, 404);
    }
    return res.status(500).send("渲染 markdown 文件时出错");
  }
}

async function serveRawMarkdown(res, filePath) {
  try {
    const markdownContent = await fs.promises.readFile(filePath, "utf-8");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(markdownContent);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return sendError(res, 404);
    }
    return res.status(500).send("读取 markdown 文件时出错");
  }
}

module.exports = {
  MarkdownRenderer,
  serveMarkdown,
  serveRawMarkdown,
};
