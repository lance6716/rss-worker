import { renderRss2 } from '../../utils/util';
import { substr } from 'runes2';

const BASE_URL = 'https://www.tombkeeper.io';
const HOME_URL = `${BASE_URL}/`;

let normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

// XML 1.0 disallows most ASCII control chars even inside CDATA.
let stripInvalidXmlChars = (s) => (s || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

// Avoid breaking CDATA sections.
let escapeCdata = (s) => (s || '').replace(/]]>/g, ']]]]><![CDATA[>');

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

// `pics` can be:
// - empty string
// - a single Weibo pic pid (e.g. "6efa3a2dgy1..."), sometimes multiple pids joined by comma/pipe
// - (future-proof) an array of pids or an array/object of pic objects
let expandWeiboPicUrls = (pics) => {
	const toPidUrl = (pid) => `https://tvax1.sinaimg.cn/large/${pid}.jpg`;

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
					return [p];
				}
				if (typeof p === 'object') {
					// Weibo API style: { large: { url } }
					if (p.large && typeof p.large.url === 'string') {
						return [p.large.url];
					}
					if (typeof p.pid === 'string') {
						return [toPidUrl(p.pid)];
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
	return pids.map((pid) => toPidUrl(pid));
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

let buildRssItemsFromWeiboObjects = (weiboObjects) => {
	let items = [];
	for (const w of weiboObjects) {
		const pubDate = parseWeiboCreatedAtToUTCString(w.created_at);
		const tombkeeperLink = `${BASE_URL}/weibo/${w.id}`;
		const originalWeiboLink = w.user_id && w.bid ? `https://weibo.com/${w.user_id}/${w.bid}` : undefined;
		const picUrls = expandWeiboPicUrls(w.pics);

		let title = normalizeText(w.text);
		if (title.length > 100) {
			title = substr(title, 0, 100) + '...';
		} else if (title.trim().length === 0) {
			title = w.screen_name ? `${w.screen_name} - ${w.id}` : w.id;
		}

		let description = stripInvalidXmlChars(w.text || '').replace(/\n/g, '<br>');
		if (originalWeiboLink) {
			description += `<br><small>原微博：<a href="${originalWeiboLink}">${originalWeiboLink}</a></small>`;
		}
		if (
			typeof w.attitudes_count === 'number' ||
			typeof w.comments_count === 'number' ||
			typeof w.reposts_count === 'number'
		) {
			const likes = typeof w.attitudes_count === 'number' ? w.attitudes_count : '-';
			const comments = typeof w.comments_count === 'number' ? w.comments_count : '-';
			const reposts = typeof w.reposts_count === 'number' ? w.reposts_count : '-';
			description += `<br><small>赞 ${likes} · 评论 ${comments} · 转发 ${reposts}</small>`;
		}

		if (picUrls.length > 0) {
			description += '<br clear="both" /><div style="clear: both"></div>';
			for (const url of picUrls) {
				description += `<img src="${url}" /><br>`;
			}
		}

		items.push({
			title: escapeCdata(stripInvalidXmlChars(title)),
			link: tombkeeperLink,
			guid: tombkeeperLink,
			description: escapeCdata(description),
			pubDate,
			author: w.screen_name || undefined,
			category: 'weibo',
			enclosure:
				picUrls.length > 0
					? {
							url: picUrls[0],
							type: 'image/jpeg',
							length: 0,
					  }
					: undefined,
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
