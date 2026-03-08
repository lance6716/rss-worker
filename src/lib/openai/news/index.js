import { renderRss2 } from '../../../utils/util';

const OPENAI_RSS_URL = 'https://openai.com/news/rss.xml';

let normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

let decodeCdata = (s) => {
	const m = (s || '').match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
	return m ? m[1] : s;
};

let extractTagText = (xml, tagName) => {
	const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
	const m = xml.match(re);
	if (!m) {
		return undefined;
	}
	return normalizeText(decodeCdata(m[1]));
};

let extractTagTexts = (xml, tagName) => {
	const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
	const out = [];
	for (const m of xml.matchAll(re)) {
		out.push(normalizeText(decodeCdata(m[1])));
	}
	return out.filter(Boolean);
};

let parseOpenAiRss = (xml) => {
	const items = [];
	const itemRe = /<item>([\s\S]*?)<\/item>/gi;
	for (const m of xml.matchAll(itemRe)) {
		const block = m[1];
		const title = extractTagText(block, 'title');
		const link = extractTagText(block, 'link');
		const description = extractTagText(block, 'description');
		const pubDate = extractTagText(block, 'pubDate');
		const guid = extractTagText(block, 'guid');
		const categories = extractTagTexts(block, 'category');

		if (!link) {
			continue;
		}

		items.push({
			title: title || link,
			link,
			description,
			pubDate,
			guid: guid || link,
			categories,
		});
	}
	return items;
};

let getLimit = (ctx, defaultLimit = 20) => {
	let limit = defaultLimit;
	try {
		const url = new URL(ctx.req.url);
		const raw = url.searchParams.get('limit');
		if (raw) {
			const n = Number(raw);
			if (Number.isFinite(n)) {
				limit = n;
			}
		}
	} catch (e) {}

	limit = Math.floor(limit);
	if (!Number.isFinite(limit) || limit <= 0) {
		return defaultLimit;
	}
	return Math.min(limit, 50);
};

let dealCategory = async (ctx, category) => {
	const limit = getLimit(ctx);

	const res = await fetch(OPENAI_RSS_URL, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
			Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9',
		},
	});

	if (!res.ok) {
		throw new Error(`failed to fetch openai rss: ${res.status} ${res.statusText}`);
	}

	const xml = await res.text();
	let items = parseOpenAiRss(xml).filter((item) => item.categories.some((c) => c.toLowerCase() === category.toLowerCase()));
	items = items.slice(0, limit);

	const pageLink = `https://openai.com/news/${category.toLowerCase()}/`;
	const data = {
		title: `OpenAI News - ${category}`,
		link: pageLink,
		description: `Latest OpenAI News posts in ${category}.`,
		language: 'en-us',
		category: 'openai',
		items: items.map((item) => ({
			title: item.title,
			link: item.link,
			guid: item.guid,
			description: item.description || item.title,
			pubDate: item.pubDate,
			category,
		})),
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
};

let setup = (route) => {
	route.get('/openai/news/engineering', (ctx) => dealCategory(ctx, 'Engineering'));
	route.get('/openai/news/research', (ctx) => dealCategory(ctx, 'Research'));
};

export default { setup };

