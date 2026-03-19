import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';

// ─── Site configuration ────────────────────────────────────────────────────────

interface LoginConfig {
  csrfSelector: string;
  usernameField: string;
  passwordField: string;
  csrfField: string;
  extraFields?: Record<string, string>;
  formSelector: string;
}

interface ListParsingConfig {
  strategy: 'authorBlock' | 'directLinks';
  authorBlockSelector?: string;
  dateSelector?: string;
  authorLinkSelector?: string;
  ancestorDepth?: number;
}

interface ContentParsingConfig {
  contentSelectors: string[];
  titleSelector?: string;
  authorSelector?: string;
  dateSelector?: string;
}

interface SiteConfig {
  label: string;
  key: string;
  baseUrl: string;
  articlesUrl: string;
  loginUrl: string;
  needsCloudflareBypass: boolean;
  login: LoginConfig;
  listParsing: ListParsingConfig;
  excludedPathPrefixes: string[];
  minPathSegments: number;
  contentParsing: ContentParsingConfig;
}

const SITE_CONFIGS: Record<string, SiteConfig> = {
  tagesSpiegelBackground: {
    label: 'Tagesspiegel Background',
    key: 'tagesSpiegelBackground',
    baseUrl: 'https://background.tagesspiegel.de',
    articlesUrl: 'https://background.tagesspiegel.de/digitalisierung-und-ki',
    loginUrl: 'https://background.tagesspiegel.de/login',
    needsCloudflareBypass: true,
    login: {
      csrfSelector: 'input[name="_csrf_token"]',
      usernameField: '_username',
      passwordField: '_password',
      csrfField: '_csrf_token',
      extraFields: { fingerprint: '' },
      formSelector: 'form',
    },
    listParsing: {
      strategy: 'authorBlock',
      authorBlockSelector: '.ts-teaser-authors',
      dateSelector: '[class*="ts-type-xs"]',
      authorLinkSelector: 'a[href*="/autor/"]',
      ancestorDepth: 8,
    },
    excludedPathPrefixes: ['autor', 'tag', 'thema', 'login', 'suche', 'about', 'impressum', 'datenschutz'],
    minPathSegments: 2,
    contentParsing: {
      contentSelectors: [
        'article',
        '[class*="article-body"]',
        '[class*="article-content"]',
        '[class*="articleBody"]',
        '[class*="article__body"]',
        'main',
        '[role="main"]',
      ],
      titleSelector: 'h1',
      authorSelector: 'a[href*="/autor/"]',
      dateSelector: 'time',
    },
  },
};

// ─── FlareSolverr session helpers ─────────────────────────────────────────────

async function fsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (data.status !== 'ok') throw new Error(`FlareSolverr: ${data.message ?? data.status}`);
  return data;
}

async function createSession(): Promise<string> {
  const data = await fsCall({ cmd: 'sessions.create' });
  return data.session as string;
}

async function destroySession(session: string): Promise<void> {
  await fsCall({ cmd: 'sessions.destroy', session }).catch(() => {});
}

async function fsGet(url: string, session: string): Promise<{ html: string; status: number; url: string; cookies: Map<string, string> }> {
  const data = await fsCall({ cmd: 'request.get', url, session, maxTimeout: 60000 });
  const s = data.solution;
  const cookies = new Map<string, string>();
  for (const c of s.cookies ?? []) cookies.set(c.name as string, c.value as string);
  return { html: s.response as string, status: s.status as number, url: s.url as string, cookies };
}

async function fsPost(
  url: string,
  session: string,
  postData: string,
  cookies?: Array<{ name: string; value: string }>,
): Promise<{ html: string; status: number; url: string; cookies: Map<string, string> }> {
  const reqBody: Record<string, unknown> = { cmd: 'request.post', url, session, postData, maxTimeout: 60000 };
  if (cookies && cookies.length > 0) reqBody.cookies = cookies;
  const data = await fsCall(reqBody);
  const s = data.solution;
  const resultCookies = new Map<string, string>();
  for (const c of s.cookies ?? []) resultCookies.set(c.name as string, c.value as string);
  return { html: s.response as string, status: s.status as number, url: s.url as string, cookies: resultCookies };
}

// ─── Login via FlareSolverr session ──────────────────────────────────────────

interface LoginDebug {
  csrfFound: boolean;
  formActionUrl: string;
  postResultUrl: string;
  postResultStatus: number;
  postHtmlSnippet: string;
}

async function login(session: string, email: string, password: string, config: SiteConfig, debug = false): Promise<LoginDebug | void> {
  // GET login page — FlareSolverr solves Cloudflare challenge and stores cookies in session
  const { html, cookies: getCookies } = await fsGet(config.loginUrl, session);

  const $ = cheerio.load(html);

  const csrf = ($(config.login.csrfSelector).val() as string) || '';
  const rawAction = $(config.login.formSelector).attr('action') ?? '/login';
  const postUrl = rawAction.startsWith('http') ? rawAction : config.baseUrl + rawAction;

  // Explicitly carry over GET cookies (PHPSESSID, cf_clearance) to POST
  // — FlareSolverr has a known bug where session cookies are not forwarded automatically
  const cookieArray = Array.from(getCookies.entries()).map(([name, value]) => ({ name, value }));

  const bodyParams: Record<string, string> = {
    [config.login.usernameField]: email,
    [config.login.passwordField]: password,
    [config.login.csrfField]: csrf,
    ...(config.login.extraFields ?? {}),
  };
  const body = new URLSearchParams(bodyParams);

  const postResult = await fsPost(postUrl, session, body.toString(), cookieArray);

  if (debug) {
    return {
      csrfFound: !!csrf,
      formActionUrl: postUrl,
      postResultUrl: postResult.url,
      postResultStatus: postResult.status,
      postHtmlSnippet: postResult.html.slice(0, 1000),
    };
  }
}

// ─── Scrape article list ──────────────────────────────────────────────────────

interface ArticleItem {
  title: string;
  url: string;
  summary: string;
  date: string;
  author: string;
}

function isArticleUrl(url: string, config: SiteConfig): boolean {
  try {
    const path = new URL(url).pathname;
    const exclusionPattern = new RegExp(
      `^\\/(${config.excludedPathPrefixes.join('|')})(\\/|$)`,
    );
    if (exclusionPattern.test(path)) return false;
    return path.split('/').filter(Boolean).length >= config.minPathSegments;
  } catch { return false; }
}

function parseArticleList(html: string, config: SiteConfig): ArticleItem[] {
  const $ = cheerio.load(html);
  const results: ArticleItem[] = [];
  const seen = new Set<string>();
  const lp = config.listParsing;

  if (lp.strategy === 'authorBlock' && lp.authorBlockSelector) {
    const authorBlocks = $(lp.authorBlockSelector).toArray();

    for (const el of authorBlocks) {
      const authorBlock = $(el);

      // Date is in the first element matching dateSelector inside the author block (e.g. "18.03.2026")
      const date = extractGermanDate(
        authorBlock.find(lp.dateSelector ?? '[class*="ts-type-xs"]').first().text(),
      );

      // Author names come from authorLinkSelector links inside the block
      const author = authorBlock.find(lp.authorLinkSelector ?? 'a[href*="/autor/"]')
        .toArray()
        .map((a: any) => $(a).text().trim())
        .join(', ');

      // Walk up ancestors to find the teaser container that has an article link
      let url = '', title = '', summary = '';
      let ancestor = authorBlock.parent();
      const depth = lp.ancestorDepth ?? 8;

      for (let d = 0; d < depth; d++) {
        if (!ancestor.length) break;
        const articleLinks = ancestor.find('a[href]').toArray().filter((a: any) => {
          const href = $(a).attr('href') ?? '';
          const abs = href.startsWith('/') ? config.baseUrl + href : href;
          return isArticleUrl(abs, config) && !href.includes('/autor/');
        });
        if (articleLinks.length > 0) {
          const href = $(articleLinks[0]).attr('href') ?? '';
          url = href.startsWith('/') ? config.baseUrl + href : href;
          const linkEl = $(articleLinks[0]);
          // Try heading inside the link first (article links often wrap the headline)
          // then h3/h4 in the ancestor (section headings tend to be h2),
          // then the link's own text as last resort
          title = linkEl.find('h1, h2, h3, h4, [class*="headline"]').first().text().trim()
            || ancestor.find('h3, h4, [class*="headline"]').first().text().trim()
            || ancestor.find('h2').first().text().trim()
            || linkEl.text().trim().slice(0, 300);
          summary = ancestor.find('p').not(authorBlock.find('p')).first().text().trim();
          break;
        }
        ancestor = ancestor.parent();
      }

      if (!url || seen.has(url)) continue;
      if (!title || title.length < 5) continue;
      seen.add(url);
      results.push({ title, url, summary, date, author });
    }
  }

  // Fallback / directLinks strategy
  if (results.length === 0) {
    $('a[href]').each((_: number, el: any) => {
      const href = $(el).attr('href') ?? '';
      const abs = href.startsWith('/') ? config.baseUrl + href : href;
      if (!abs.startsWith(config.baseUrl) || seen.has(abs)) return;
      if (!isArticleUrl(abs, config)) return;
      const title = $(el).text().trim();
      if (title.length < 10) return;
      seen.add(abs);
      results.push({ title, url: abs, summary: '', date: '', author: '' });
    });
  }

  return results;
}

// ─── Scrape article content ───────────────────────────────────────────────────

interface ArticleContent {
  title: string;
  url: string;
  content: string;
  date: string;
  author: string;
}

function extractGermanDate(raw: string): string {
  const m = raw.match(/\d{2}\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

function parseArticleContent(html: string, articleUrl: string, config: SiteConfig): ArticleContent {
  const $ = cheerio.load(html);
  const cp = config.contentParsing;

  // Prioritise titleSelector — [class*="title"] often matches navigation/category labels first
  const titleSel = cp.titleSelector ?? 'h1';
  const title = $(titleSel).first().text().trim()
    || $('[class*="headline"]').first().text().trim()
    || $('title').text().trim();

  // Date: prefer <time datetime>, fall back to text containing dd.mm.yyyy
  const dateSel = cp.dateSelector ?? 'time';
  const timeEl = $(dateSel).first();
  const rawDate = timeEl.attr('datetime') ?? timeEl.text().trim()
    ?? $('[class*="ts-type-xs"]').first().text().trim();
  const date = extractGermanDate(rawDate);

  // Author: use authorSelector which is specific to author profiles on this site
  const authorSel = cp.authorSelector ?? '[rel="author"]';
  const authorEls = $(authorSel).toArray();
  const author = authorEls.length > 0
    ? authorEls.map((a: any) => $(a).text().trim()).join(', ')
    : $('[rel="author"]').first().text().trim();

  let contentEl = null;
  for (const sel of cp.contentSelectors) {
    const found = $(sel).first();
    if (found.length) { contentEl = found; break; }
  }

  let content = '';
  if (contentEl) {
    contentEl.find('script, style, nav, header, footer, [class*="sidebar"], [class*="related"]').remove();
    const paragraphs = contentEl.find('p, h2, h3, h4, blockquote').toArray();
    content = paragraphs.length > 0
      ? paragraphs.map((el: any) => $(el).text().trim()).filter((t: string) => t.length > 0).join('\n\n')
      : contentEl.text().trim();
  }

  return { title, url: articleUrl, content, date, author };
}

// ─── n8n node ─────────────────────────────────────────────────────────────────

export class ArticleScraper implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Article Scraper',
    name: 'articleScraper',
    icon: 'file:tagesspiegel.svg',
    group: ['input'],
    version: 1,
    description: 'Scrape articles from a configured site or a custom config-driven site',
    defaults: { name: 'Article Scraper' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'articleScraperApi', required: true }],
    properties: [
      {
        displayName: 'Site',
        name: 'site',
        type: 'options',
        noDataExpression: true,
        default: 'tagesSpiegelBackground',
        description: 'Which site to scrape',
        options: [
          {
            name: 'Tagesspiegel Background',
            value: 'tagesSpiegelBackground',
            description: 'Tagesspiegel Background – Digitalisierung & KI',
          },
          {
            name: 'Custom',
            value: 'custom',
            description: 'Provide a JSON SiteConfig object',
          },
        ],
      },
      {
        displayName: 'Custom Config (JSON)',
        name: 'customConfig',
        type: 'string',
        typeOptions: { rows: 8 },
        default: '',
        required: true,
        description: 'Paste a JSON object matching the SiteConfig interface',
        displayOptions: { show: { site: ['custom'] } },
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Get Article List',
            value: 'getArticleList',
            description: 'Fetch list of articles with title, URL, summary, date',
            action: 'Get list of articles',
          },
          {
            name: 'Get Article Content',
            value: 'getArticleContent',
            description: 'Fetch the full content of a single article',
            action: 'Get article content',
          },
          {
            name: 'Get All Articles with Content',
            value: 'getAllArticlesWithContent',
            description: 'Fetch every article title and its full content in one step',
            action: 'Get all articles with content',
          },
          {
            name: 'Debug',
            value: 'debug',
            description: 'Return raw HTML from articles page for debugging',
            action: 'Debug login and page',
          },
        ],
        default: 'getAllArticlesWithContent',
      },
      {
        displayName: 'Article URL',
        name: 'articleUrl',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://background.tagesspiegel.de/...',
        description: 'URL of the article to fetch content from',
        displayOptions: { show: { operation: ['getArticleContent'] } },
      },
      {
        displayName: 'Today Only',
        name: 'todayOnly',
        type: 'boolean',
        default: true,
        description: 'Whether to return only articles published today',
        displayOptions: { show: { operation: ['getArticleList', 'getAllArticlesWithContent'] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const site = this.getNodeParameter('site', 0, 'tagesSpiegelBackground') as string;

    let config: SiteConfig;
    if (site === 'custom') {
      const raw = this.getNodeParameter('customConfig', 0) as string;
      if (!raw) throw new NodeOperationError(this.getNode(), 'Custom Config (JSON) is required when site = Custom');
      try {
        config = JSON.parse(raw) as SiteConfig;
      } catch (e) {
        throw new NodeOperationError(this.getNode(), `Custom Config JSON is invalid: ${(e as Error).message}`);
      }
    } else {
      config = SITE_CONFIGS[site];
      if (!config) throw new NodeOperationError(this.getNode(), `Unknown site key: ${site}`);
    }

    const credentials = await this.getCredentials('articleScraperApi');
    const operation = this.getNodeParameter('operation', 0) as string;
    const email = credentials.email as string;
    const password = credentials.password as string;

    const session = await createSession();

    try {
      if (operation === 'debug') {
        // Show login page form fields BEFORE attempting login
        const { html: loginHtml } = await fsGet(config.loginUrl, session);
        const $l = cheerio.load(loginHtml);
        const formFields = $l('input').toArray().map((el: any) => ({
          name: $l(el).attr('name'),
          type: $l(el).attr('type'),
          value: $l(el).attr('value')?.slice(0, 20),
        }));
        const formAction = $l('form').attr('action') ?? '(none)';

        const loginDebug = await login(session, email, password, config, true) as LoginDebug;
        const { html, status, url, cookies } = await fsGet(config.articlesUrl, session);
        const loginStatusMatch = html.match(/"user_login_status":"([^"]+)"/);

        // Extract first article container HTML to diagnose selectors
        const $a = cheerio.load(html);
        const authorBlockSel = config.listParsing.authorBlockSelector ?? '.ts-teaser-authors';
        const firstAuthorBlock = $a(authorBlockSel).first();
        const firstContainerHtml = firstAuthorBlock.parent().prop('outerHTML')?.slice(0, 3000) ?? `(no ${authorBlockSel} found)`;
        const allContainerClasses = $a(authorBlockSel)
          .toArray().slice(0, 5).map((el: any) => $a(el).parent().attr('class') ?? '').join(' | ');

        return [[{
          json: {
            loginFormAction: formAction,
            loginFormFields: formFields,
            loginCsrfFound: loginDebug.csrfFound,
            loginFormActionUrl: loginDebug.formActionUrl,
            loginPostResultUrl: loginDebug.postResultUrl,
            loginPostResultStatus: loginDebug.postResultStatus,
            loginPostHtmlSnippet: loginDebug.postHtmlSnippet,
            articlesPageStatus: status,
            articlesPageUrl: url,
            userLoginStatus: loginStatusMatch?.[1] ?? 'unknown',
            cookieKeys: Array.from(cookies.keys()),
            firstContainerClasses: allContainerClasses,
            firstContainerHtml,
          } as unknown as INodeExecutionData['json'],
        }]];
      }

      await login(session, email, password, config, false);

      const todayOnly = this.getNodeParameter('todayOnly', 0, true) as boolean;
      const todayDE = new Date().toLocaleDateString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin',
      }); // e.g. "18.03.2026"
      // ISO date in Berlin timezone for matching datetime attributes like "2026-03-18T..."
      const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); // "2026-03-18"

      function matchesToday(date: string): boolean {
        if (!date) return false;
        return date.includes(todayDE) || date.startsWith(todayISO) || date.includes(todayISO);
      }

      if (operation === 'getArticleList') {
        const { html } = await fsGet(config.articlesUrl, session);
        const allArticles = parseArticleList(html, config);
        const articles = todayOnly ? allArticles.filter((a) => matchesToday(a.date)) : allArticles;
        if (articles.length === 0) {
          const rawDates = allArticles.map((a) => a.date || '(empty)').slice(0, 10).join(' | ');
          throw new NodeOperationError(
            this.getNode(),
            todayOnly
              ? `No articles found for today (${todayDE} / ${todayISO}). Raw dates from page: ${rawDates || 'none found'}`
              : 'No articles found.',
          );
        }
        return [articles.map((a) => ({ json: a as unknown as INodeExecutionData['json'] }))];
      }

      if (operation === 'getAllArticlesWithContent') {
        const { html: listHtml } = await fsGet(config.articlesUrl, session);
        const allArticles = parseArticleList(listHtml, config);
        const articles = todayOnly ? allArticles.filter((a) => matchesToday(a.date)) : allArticles;
        if (articles.length === 0) {
          const rawDates = allArticles.map((a) => a.date || '(empty)').slice(0, 10).join(' | ');
          throw new NodeOperationError(
            this.getNode(),
            todayOnly
              ? `No articles found for today (${todayDE} / ${todayISO}). Raw dates from page: ${rawDates || 'none found'}`
              : 'No articles found.',
          );
        }
        const results: INodeExecutionData[] = [];
        for (const article of articles) {
          const { html: contentHtml } = await fsGet(article.url, session);
          const content = parseArticleContent(contentHtml, article.url, config);
          results.push({
            json: {
              title: content.title || article.title,
              url: article.url,
              summary: article.summary,
              date: content.date || article.date,
              author: content.author || article.author,
              content: content.content,
            } as unknown as INodeExecutionData['json'],
          });
        }
        return [results];
      }

      if (operation === 'getArticleContent') {
        const articleUrl = this.getNodeParameter('articleUrl', 0) as string;
        if (!articleUrl) throw new NodeOperationError(this.getNode(), 'Article URL is required');
        const { html } = await fsGet(articleUrl, session);
        const result = parseArticleContent(html, articleUrl, config);
        return [[{ json: result as unknown as INodeExecutionData['json'] }]];
      }

      throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
    } catch (error) {
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(
        this.getNode(),
        `Request failed: ${(error as Error).message}`,
        { description: 'Check credentials and ensure FlareSolverr is running at ' + FLARESOLVERR_URL },
      );
    } finally {
      await destroySession(session);
    }
  }
}
