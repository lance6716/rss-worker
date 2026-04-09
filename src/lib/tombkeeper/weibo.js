import { renderRss2 } from '../../utils/util';
import { substr } from 'runes2';

const BASE_URL = 'https://www.tombkeeper.io';
const HOME_URL = `${BASE_URL}/`;

let normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

// XML 1.0 disallows most ASCII control chars even inside CDATA.
let stripInvalidXmlChars = (s) => (s || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

// Avoid breaking CDATA sections.
let escapeCdata = (s) => (s || '').replace(/]]>/g, ']]]]><![CDATA[>');

// Escape minimal HTML attribute chars for our injected <a href="...">.
let escapeHtmlAttr = (s) =>
	(s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

let isHttpUrl = (s) => typeof s === 'string' && (s.startsWith('https://') || s.startsWith('http://'));

let buildUrlInfoMap = (urlInfo) => {
	const m = new Map();
	if (!Array.isArray(urlInfo)) {
		return m;
	}
	for (const info of urlInfo) {
		if (!info || typeof info !== 'object') {
			continue;
		}
		const shortUrl = typeof info.short_url === 'string' ? info.short_url.trim() : '';
		if (!isHttpUrl(shortUrl)) {
			continue;
		}
		const longUrl = typeof info.long_url === 'string' ? info.long_url.trim() : '';
		if (isHttpUrl(longUrl)) {
			m.set(shortUrl, longUrl);
		} else {
			m.set(shortUrl, shortUrl);
		}
	}
	return m;
};

// Convert plain-text URLs into clickable links.
// - Prefer url_info.long_url as href when available (keep the displayed text as the original short url).
// - Keep it simple: only linkify http(s)://... tokens.
let linkifyUrls = (text, urlInfo) => {
	if (!text) {
		return '';
	}
	const urlMap = buildUrlInfoMap(urlInfo);
	const urlRe = /https?:\/\/[^\s<>"']+/g;
	const trailingPunctRe = /[)\],.!;:'"’”。，；：！？）】》」』]+$/;

	return String(text).replace(urlRe, (raw) => {
		let url = raw;
		let trailing = '';
		const m = url.match(trailingPunctRe);
		if (m) {
			trailing = m[0];
			url = url.slice(0, -trailing.length);
		}

		const href = urlMap.get(url) || url;
		if (!isHttpUrl(href)) {
			return raw;
		}
		return `<a href="${escapeHtmlAttr(href)}">${url}</a>${trailing}`;
	});
};

let parseWeiboCreatedAtToUTCString = (createdAt) => {
	if (typeof createdAt !== 'string') {
		return undefined;
	}

	let iso = createdAt;
	if (iso.startsWith('$D')) {
		iso = iso.slice(2);
	}

	let d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return undefined;
	}
	return d.toUTCString();
};

// Weibo images are served from several equivalent CDNs (wx1-4 / tvax1-4 / tva1-4).
// Some networks/readers cannot reach tvax*, so normalize them back to a stable wx* host.
// Also, tombkeeper's `pics` field sometimes provides a bare pid without extension; some RSS readers
// don't like extension-less URLs, so we append `.jpg` in that case.
let normalizeSinaimgImageUrl = (url) => {
	if (typeof url !== 'string') {
		return '';
	}
	let s = url.trim();
	if (s === '') {
		return '';
	}
	if (s.startsWith('//')) {
		s = `https:${s}`;
	}

	let u;
	try {
		u = new URL(s);
	} catch (e) {
		// If it isn't a valid URL, keep the original string (caller may treat it as a pid).
		return url;
	}

	// Normalize host: tvax*/tva*/wx* -> wx4 (any wx[1-4] works for the same pid).
	const isWeiboImageHost = /^(?:wx|tvax|tva)[1-4]\.sinaimg\.cn$/i.test(u.hostname);
	if (isWeiboImageHost) {
		u.hostname = 'wx4.sinaimg.cn';
	}

	// Normalize extension: /.../<pid> -> /.../<pid>.jpg (when no extension is present).
	// Only do this for plausible pid segments to avoid breaking non-image URLs.
	if (isWeiboImageHost) {
		const m = u.pathname.match(/^(.*\/)([A-Za-z0-9]+)$/);
		if (m) {
			u.pathname = `${m[1]}${m[2]}.jpg`;
		}
	}

	return u.toString();
};

// `pics` can be:
// - empty string
// - a single Weibo pic pid (e.g. "6efa3a2dgy1..."), sometimes multiple pids joined by comma/pipe
// - (future-proof) an array of pids or an array/object of pic objects
let expandWeiboPicUrls = (pics) => {
	// Tombkeeper usually returns a Weibo picture pid without extension.
	// Use wx4 + .jpg for best compatibility across RSS readers/networks.
	const toPidUrl = (pid) => `https://wx4.sinaimg.cn/large/${pid}.jpg`;
	const toUrl = (pidOrUrl) => {
		if (!pidOrUrl) {
			return undefined;
		}
		if (typeof pidOrUrl !== 'string') {
			return undefined;
		}
		const s = pidOrUrl.trim();
		if (s === '') {
			return undefined;
		}
		if (s.startsWith('https://') || s.startsWith('http://')) {
			return normalizeSinaimgImageUrl(s);
		}
		if (s.startsWith('//')) {
			return normalizeSinaimgImageUrl(s);
		}
		// Sometimes the pid may already include an extension.
		if (/^[A-Za-z0-9]+\.(?:jpe?g|png|gif|webp)$/i.test(s)) {
			return normalizeSinaimgImageUrl(`https://wx4.sinaimg.cn/large/${s}`);
		}
		// Only accept plausible pid strings to avoid injecting arbitrary HTML.
		if (/^[A-Za-z0-9]+$/.test(s)) {
			return toPidUrl(s);
		}
		return undefined;
	};

	if (!pics) {
		return [];
	}

	// Object/array forms (not observed on tombkeeper yet, but keep it robust).
	if (Array.isArray(pics)) {
		return pics
			.flatMap((p) => {
				if (!p) {
					return [];
				}
				if (typeof p === 'string') {
					return [toUrl(p)];
				}
				if (typeof p === 'object') {
					// Weibo API style: { large: { url } }
					if (p.large && typeof p.large.url === 'string') {
						return [toUrl(p.large.url)];
					}
					if (typeof p.url === 'string') {
						return [toUrl(p.url)];
					}
					if (typeof p.pid === 'string') {
						return [toUrl(p.pid)];
					}
				}
				return [];
			})
			.filter(Boolean);
	}

	if (typeof pics === 'object') {
		return Object.values(pics)
			.flatMap((p) => expandWeiboPicUrls(p))
			.filter(Boolean);
	}

	if (typeof pics !== 'string') {
		return [];
	}

	const raw = pics.trim();
	if (raw === '') {
		return [];
	}

	// Sometimes the field is a JSON string.
	if (raw.startsWith('[') && raw.endsWith(']')) {
		try {
			const arr = JSON.parse(raw);
			return expandWeiboPicUrls(arr);
		} catch (e) {
			// ignore and fall back to split heuristics
		}
	}

	const pids = raw.split(/[\s,|]+/).map((s) => s.trim()).filter(Boolean);
	return pids.map((pidOrUrl) => toUrl(pidOrUrl)).filter(Boolean);
};

let extractNextFlightPayloadFromHtml = (html) => {
	const marker = 'self.__next_f.push([1,';
	let idx = 0;
	let chunks = [];

	while ((idx = html.indexOf(marker, idx)) !== -1) {
		const start = idx + marker.length;
		if (html[start] !== '"') {
			idx = start;
			continue;
		}

		let i = start + 1;
		let escaped = false;
		while (i < html.length) {
			const ch = html[i];
			if (escaped) {
				escaped = false;
				i++;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				i++;
				continue;
			}
			if (ch === '"') {
				break;
			}
			i++;
		}

		if (i >= html.length) {
			break;
		}

		const literal = html.slice(start, i + 1);
		try {
			chunks.push(JSON.parse(literal));
		} catch (e) {
			// If one chunk fails to decode, continue with others.
		}

		idx = i + 1;
	}

	return chunks.join('');
};

let isProbablyWeiboObject = (o) => {
	if (!o || typeof o !== 'object') {
		return false;
	}

	return (
		typeof o.id === 'string' &&
		/^\d{5,}$/.test(o.id) &&
		typeof o.user_id === 'string' &&
		typeof o.bid === 'string' &&
		typeof o.screen_name === 'string' &&
		typeof o.text === 'string' &&
		typeof o.created_at === 'string'
	);
};

let extractWeiboObjectsFromFlightPayload = (payload) => {
	const lines = payload.split('\n');
	const weiboById = new Map();

	const visit = (v) => {
		if (!v) {
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) {
				visit(item);
			}
			return;
		}
		if (typeof v !== 'object') {
			return;
		}

		if (isProbablyWeiboObject(v)) {
			weiboById.set(v.id, v);
		}
		// Some structures wrap it as { weibo: {...} }.
		if (v.weibo && isProbablyWeiboObject(v.weibo)) {
			weiboById.set(v.weibo.id, v.weibo);
		}

		for (const item of Object.values(v)) {
			visit(item);
		}
	};

	for (const line of lines) {
		const colon = line.indexOf(':');
		if (colon === -1) {
			continue;
		}
		const valueText = line.slice(colon + 1);
		const fc = valueText[0];
		if (!fc) {
			continue;
		}
		// Only attempt to parse JSON-like values.
		if (!['{', '[', '"', 'n', 't', 'f', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(fc)) {
			continue;
		}

		let parsed;
		try {
			parsed = JSON.parse(valueText);
		} catch (e) {
			continue;
		}

		visit(parsed);
	}

	return Array.from(weiboById.values());
};

let extractWeiboIdsFromHtml = (html) => {
	let ids = new Set();
	for (const m of html.matchAll(/\/weibo\/(\d{5,})/g)) {
		ids.add(m[1]);
	}
	return Array.from(ids);
};

let renderWeiboTextHtml = (w) => {
	const text = stripInvalidXmlChars(w?.text || '');
	const linked = linkifyUrls(text, w?.url_info);
	return linked.replace(/\n/g, '<br>');
};

let renderWeiboMetaHtml = (w, { linkLabel } = {}) => {
	let html = '';
	const label = linkLabel || '原微博';
	const weiboLink = w?.user_id && w?.bid ? `https://weibo.com/${w.user_id}/${w.bid}` : undefined;
	if (weiboLink) {
		html += `<br><small>${label}：<a href="${weiboLink}">${weiboLink}</a></small>`;
	}
	if (
		typeof w?.attitudes_count === 'number' ||
		typeof w?.comments_count === 'number' ||
		typeof w?.reposts_count === 'number'
	) {
		const likes = typeof w.attitudes_count === 'number' ? w.attitudes_count : '-';
		const comments = typeof w.comments_count === 'number' ? w.comments_count : '-';
		const reposts = typeof w.reposts_count === 'number' ? w.reposts_count : '-';
		html += `<br><small>赞 ${likes} · 评论 ${comments} · 转发 ${reposts}</small>`;
	}
	return html;
};

let renderWeiboPicsHtml = (w) => {
	const picUrls = expandWeiboPicUrls(w?.pics);
	if (picUrls.length === 0) {
		return '';
	}
	let html = '<br clear="both" /><div style="clear: both"></div>';
	for (const url of picUrls) {
		html += `<img src="${url}" /><br>`;
	}
	return html;
};

let renderRetweetBlockHtml = (retweetWeibo) => {
	if (!retweetWeibo || typeof retweetWeibo !== 'object') {
		return '';
	}
	// Tombkeeper's data structure uses `retweet_weibo` for the original weibo in a repost.
	let html = '<br clear="both" /><div style="clear: both"></div>';
	html +=
		'<blockquote style="background: #80808010;border-top:1px solid #80808030;border-bottom:1px solid #80808030;margin:0;padding:5px 20px;">';
	if (retweetWeibo.screen_name) {
		html += `<div><strong>@${retweetWeibo.screen_name}</strong></div>`;
	}
	html += renderWeiboTextHtml(retweetWeibo);
	html += renderWeiboPicsHtml(retweetWeibo);
	// Keep the link label explicit to avoid confusion with the outer item meta.
	html += renderWeiboMetaHtml(retweetWeibo, { linkLabel: '被转发微博' });
	html += '</blockquote>';
	return html;
};

let buildRssItemsFromWeiboObjects = (weiboObjects) => {
	// Tombkeeper embeds the original weibo object for reposts (retweet_weibo / retweet_id).
	// Our payload walker sees both, but we only want the outer repost as an RSS item.
	const embeddedRetweetIds = new Set();
	for (const w of weiboObjects) {
		if (typeof w?.retweet_id === 'string' && /^\d{5,}$/.test(w.retweet_id)) {
			embeddedRetweetIds.add(w.retweet_id);
		}
		if (typeof w?.retweet_weibo?.id === 'string' && /^\d{5,}$/.test(w.retweet_weibo.id)) {
			embeddedRetweetIds.add(w.retweet_weibo.id);
		}
	}

	let items = [];
	for (const w of weiboObjects) {
		if (embeddedRetweetIds.has(w.id)) {
			continue;
		}

		const pubDate = parseWeiboCreatedAtToUTCString(w.created_at);
		const tombkeeperLink = `${BASE_URL}/weibo/${w.id}`;

		let title = normalizeText(w.text);
		if (title.length > 100) {
			title = substr(title, 0, 100) + '...';
		} else if (title.trim().length === 0) {
			title = w.screen_name ? `${w.screen_name} - ${w.id}` : w.id;
		}

		let description = renderWeiboTextHtml(w);
		// Include the original weibo content for reposts (tombkeeper shows both on the website).
		if (w.retweet_weibo) {
			description += renderRetweetBlockHtml(w.retweet_weibo);
		}
		description += renderWeiboMetaHtml(w);
		description += renderWeiboPicsHtml(w);

		items.push({
			title: escapeCdata(stripInvalidXmlChars(title)),
			link: tombkeeperLink,
			guid: tombkeeperLink,
			description: escapeCdata(description),
			pubDate,
			author: w.screen_name || undefined,
			category: 'weibo',
			// RSS enclosure requires a stable MIME type; rely on <img> tags in the description for broad RSS reader support.
		});
	}

	// Newest first (RSS readers usually show descending).
	items.sort((a, b) => {
		const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
		const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
		return tb - ta;
	});

	// Keep it small and fast.
	return items.slice(0, 20);
};

let buildRssItemsFromWeiboIds = (ids) => {
	return ids.slice(0, 20).map((id) => {
		const tombkeeperLink = `${BASE_URL}/weibo/${id}`;
		return {
			title: `weibo ${id}`,
			link: tombkeeperLink,
			guid: tombkeeperLink,
			description: escapeCdata(`https://www.tombkeeper.io/weibo/${id}`),
			category: 'weibo',
		};
	});
};

let deal = async (ctx) => {
	let res = await fetch(HOME_URL, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
		},
	});

	if (!res.ok) {
		throw new Error(`failed to fetch tombkeeper home page: ${res.status} ${res.statusText}`);
	}

	const html = await res.text();

	// Approach 1: parse embedded Next.js Flight payload and extract weibo objects.
	let items = [];
	try {
		const payload = extractNextFlightPayloadFromHtml(html);
		const weiboObjects = extractWeiboObjectsFromFlightPayload(payload);
		items = buildRssItemsFromWeiboObjects(weiboObjects);
	} catch (e) {
		items = [];
	}

	// Fallback: at least produce a feed with links if the payload structure changes.
	if (items.length === 0) {
		const ids = extractWeiboIdsFromHtml(html);
		items = buildRssItemsFromWeiboIds(ids);
	}

	if (items.length === 0) {
		throw new Error('failed to parse tombkeeper weibo list (no items found)');
	}

	let data = {
		title: 'tombkeeper.io - 首页微博流',
		link: HOME_URL,
		description: 'tombkeeper.io 首页的微博流。',
		language: 'zh-cn',
		category: 'tombkeeper',
		items,
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
};

let setup = (route) => {
	route.get('/tombkeeper/weibo', deal);
};

export default { setup };
