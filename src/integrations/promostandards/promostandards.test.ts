/** PromoStandards adapters (ADR 0017): XML, SOAP, services, mapping, whole-catalog fetch. */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseXml, XmlError, find, text } from './xml';
import { call, endpointProblem, httpPost, SoapError } from './soap';
import { normaliseHex, parseConfiguration, priceToCents } from './services';
import { mapProduct, methodFor, templateFor, zoneFor, slugify } from './map';
import { fetchSupplierCatalog } from './catalog';
import { fakeSupplier, FAKE_CREDENTIALS, requestField } from './fake-supplier';

const ENDPOINTS = { productData: 'https://ps.acme.test/pd', pricing: 'https://ps.acme.test/ppc' };

describe('xml', () => {
  it('reads elements, attributes, entities and CDATA, ignoring namespace prefixes', () => {
    const n = parseXml(`<?xml version="1.0"?><!-- c --><a:Root xmlns:a="urn:a" id='7'><a:name>Tom &amp; Jerry &#x2014; &lt;b&gt;</a:name><b:note><![CDATA[<raw & keep>]]></b:note><empty/></a:Root>`);
    expect(n.name).toBe('Root');
    expect(n.attrs.id).toBe('7');
    expect(text(n, 'name')).toBe('Tom & Jerry \u2014 <b>');
    expect(text(n, 'note')).toBe('<raw & keep>');
    expect(find(n, 'empty')).toBeDefined();
  });

  it('refuses DOCTYPE (no entity expansion or external entities, ever)', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><r>&lol2;</r>`;
    expect(() => parseXml(bomb)).toThrow(XmlError);
    expect(() => parseXml(`<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>`)).toThrow(/DOCTYPE/);
    expect(() => parseXml(`<r>&xxe;</r>`)).not.toThrow(); // unknown entity stays literal text
    expect(text(parseXml(`<r><x>&xxe;</x></r>`), 'x')).toBe('&xxe;');
  });

  it('rejects malformed documents', () => {
    for (const bad of ['<a><b></a>', '<a>', '<a></a><b></b>', '<a x="1></a>', '<a><!-- x</a>']) expect(() => parseXml(bad), bad).toThrow(XmlError);
    expect(() => parseXml('<a>' + '<b>'.repeat(70) + '</b>'.repeat(70) + '</a>')).toThrow(/deeply/);
  });

  it('keeps quoted ">" inside attribute values', () => {
    expect(parseXml(`<a t="x>y"/>`).attrs.t).toBe('x>y');
  });
});

describe('prices and colours', () => {
  it('turns decimal strings into integer cents without floating point, half up', () => {
    expect(priceToCents('3.45')).toBe(345);
    expect(priceToCents('3.456')).toBe(346);
    expect(priceToCents('3.4549')).toBe(345);
    expect(priceToCents('12')).toBe(1200);
    expect(priceToCents('0.105')).toBe(11);
    expect(priceToCents('99.00', 12)).toBe(825); // per dozen → each
    expect(priceToCents('1.00', 1000)).toBe(0);
    for (const bad of ['', '-1.00', '1,00', '1e3', 'abc', '1.2.3', undefined]) expect(priceToCents(bad)).toBeNull();
  });

  it('normalises hex colours', () => {
    expect(normaliseHex('000000')).toBe('#000000');
    expect(normaliseHex('#fff')).toBe('#FFFFFF');
    expect(normaliseHex('1b2a4a')).toBe('#1B2A4A');
    expect(normaliseHex('navy')).toBeUndefined();
  });

  it('skips price breaks in units it cannot convert, and says so', () => {
    const problems: string[] = [];
    const cfg = parseConfiguration(
      parseXml(`<R><Configuration><productId>X</productId><currency>USD</currency><PartArray><Part><partId>X-1</partId><PartPriceArray>
        <PartPrice><minQuantity>12</minQuantity><price>2.00</price><priceUom>EA</priceUom></PartPrice>
        <PartPrice><minQuantity>50</minQuantity><price>9.00</price><priceUom>BX</priceUom></PartPrice>
        <PartPrice><minQuantity>0</minQuantity><price>1.00</price></PartPrice></PartPriceArray></Part></PartArray></Configuration></R>`),
      problems,
    );
    expect(cfg.parts[0]!.breaks).toEqual([{ minQuantity: 12, unitCents: 200 }]);
    expect(problems).toEqual(['part X-1: price unit "BX" not understood', 'part X-1: unreadable price break']);
  });
});

describe('mapping rules', () => {
  it('picks a template from sub-category, then category, then name', () => {
    expect(templateFor({ name: 'Anything', categories: [{ category: 'Apparel', subCategory: 'Polos' }] })).toBe('polo');
    expect(templateFor({ name: 'Unisex Crew', categories: [{ category: 'T-Shirts' }] })).toBe('tee');
    expect(templateFor({ name: '16 oz Travel Mug', categories: [{ category: 'Promotional' }] })).toBe('tumbler');
    expect(templateFor({ name: 'Canvas Tote Bag', categories: [] })).toBe('tote');
    expect(templateFor({ name: 'USB Drive', categories: [{ category: 'Technology' }] })).toBeNull();
    expect(templateFor({ name: 'USB Drive', categories: [] }, 'journal')).toBe('journal');
  });

  it('maps decoration names to methods and refuses what it does not know', () => {
    expect(methodFor('Screen Printed')).toBe('screen_print');
    expect(methodFor('Silkscreen')).toBe('screen_print');
    expect(methodFor('Direct to Garment (DTG)')).toBe('dtg');
    expect(methodFor('Laser Engraved')).toBe('laser_engraving');
    expect(methodFor('Blind Deboss')).toBe('deboss_emboss');
    expect(methodFor('Heat Transfer')).toBe('heat_transfer_htv');
    expect(methodFor('4CP Full Color')).toBeNull();
    // Ambiguous (vinyl? DTF? printed transfer?): not guessed, so it's reported instead of mispriced.
    expect(methodFor('Full Color Transfer')).toBeNull();
  });

  it('maps location names only onto zones the template has', () => {
    expect(zoneFor('tee', 'Full Front')).toBe('full_front');
    expect(zoneFor('tee', 'Center Front')).toBe('full_front');
    expect(zoneFor('polo', 'Left Chest')).toBe('left_chest');
    expect(zoneFor('tee', 'Sleeve')).toBeNull();
    expect(zoneFor('tumbler', 'Side 1')).toBe('one_side');
    expect(zoneFor('tumbler', 'Full Wrap')).toBe('wrap');
    expect(zoneFor('cap', 'Front')).toBe('front_panel');
    expect(zoneFor('cap', 'Back')).toBeNull();
    expect(zoneFor('journal', 'Front Cover')).toBe('front_cover');
  });

  it('slugs are URL-safe and bounded', () => {
    expect(slugify('20 oz Recycled Steel Tumbler®')).toBe('20-oz-recycled-steel-tumbler');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('***')).toBe('product');
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it('skips a product it cannot price, rather than inventing a cost', () => {
    const r = mapProduct(
      { productId: 'P', name: 'Tee', categories: [{ category: 'T-Shirts' }], colors: [{ name: 'Black', hex: '#000000' }], isCloseout: false },
      { productId: 'P', currency: 'USD', parts: [], locations: [{ name: 'Front', isDefault: true, decorations: [{ name: 'Screen Print', widthIn: 10, heightIn: 12, isDefault: true }] }] },
    );
    expect(r.product).toBeUndefined();
    expect(r.notes.join()).toMatch(/no readable blank price/);
  });
});

describe('SOAP', () => {
  it('turns faults, ServiceMessage errors and HTTP errors into SoapError, keeping warnings', async () => {
    const reply = (status: number, inner: string) => async () => ({ status, body: `<E:Envelope xmlns:E="x"><E:Body>${inner}</E:Body></E:Envelope>` });
    const req = { url: 'https://x.test', action: 'a', body: '<x/>', namespaces: {} };
    await expect(call(reply(500, '<E:Fault><faultcode>Server</faultcode><faultstring>boom</faultstring></E:Fault>'), req)).rejects.toMatchObject({ kind: 'fault', message: expect.stringMatching(/boom/) });
    await expect(call(reply(200, '<R><ServiceMessageArray><ServiceMessage><code>105</code><description>Authentication failed</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></R>'), req)).rejects.toMatchObject({ kind: 'service', code: '105' });
    await expect(call(reply(200, '<R><ErrorMessage><code>999</code><description>legacy</description></ErrorMessage></R>'), req)).rejects.toMatchObject({ kind: 'service', code: '999' });
    await expect(call(async () => ({ status: 503, body: 'Service Unavailable' }), req)).rejects.toMatchObject({ kind: 'http', code: '503' });
    await expect(call(async () => ({ status: 200, body: '<not xml' }), req)).rejects.toMatchObject({ kind: 'parse' });
    const ok = await call(reply(200, '<R><v>1</v><ServiceMessageArray><ServiceMessage><code>200</code><description>partial</description><severity>Warning</severity></ServiceMessage></ServiceMessageArray></R>'), req);
    expect(text(ok.body, 'v')).toBe('1');
    expect(ok.messages).toEqual([{ code: '200', description: 'partial', severity: 'Warning' }]);
  });

  it('escapes credentials into the request and sends the documented envelope', async () => {
    let sent = '';
    await fetchSupplierCatalog(
      async (url, action, xml) => {
        if (action === 'getProductSellable') sent = xml;
        return fakeSupplier()(url, action, xml);
      },
      { endpoints: ENDPOINTS, credentials: { id: 'a<b', password: 'p&"q' }, currency: 'USD' },
    ).catch(() => undefined);
    expect(requestField(sent, 'id')).toBe('a<b');
    expect(requestField(sent, 'password')).toBe('p&"q');
    expect(requestField(sent, 'wsVersion')).toBe('2.0.0');
    expect(sent).toContain('xmlns:ns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"');
  });

  it('refuses endpoints that are not public https', () => {
    expect(endpointProblem('http://supplier.test/ps')).toBe('must use https');
    expect(endpointProblem('https://user:pw@supplier.test/ps')).toBe('must not contain credentials');
    expect(endpointProblem('https://127.0.0.1/ps')).toMatch(/private/);
    expect(endpointProblem('https://169.254.169.254/latest')).toMatch(/private/);
    expect(endpointProblem('https://ps.internal/x')).toMatch(/private/);
    expect(endpointProblem('https://ps.supplier.com/ProductData/v2')).toBeNull();
  });

  it('the real transport: SOAPAction header, no redirects, body cap, and names that resolve privately are refused', async () => {
    let seen: { action?: string | string[] | undefined; type?: string | undefined } = {};
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        return res.end();
      }
      if (req.url === '/huge') {
        res.writeHead(200);
        const chunk = Buffer.alloc(1024 * 1024, 32);
        let n = 0;
        const pump = () => {
          while (n < 25 && res.write(chunk)) n++;
          if (n < 25) res.once('drain', pump);
          else res.end();
        };
        return pump();
      }
      seen = { action: req.headers.soapaction, type: req.headers['content-type'] };
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<s:Envelope xmlns:s="x"><s:Body><R><ok>yes</ok></R></s:Body></s:Envelope>');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const post = httpPost({ allowInsecure: true, timeoutMs: 5000 });
      const r = await call(post, { url: `${base}/ps`, action: 'getProduct', body: '<x/>', namespaces: {} });
      expect(text(r.body, 'ok')).toBe('yes');
      expect(seen).toEqual({ action: '"getProduct"', type: 'text/xml; charset=utf-8' });
      await expect(post(`${base}/redirect`, 'a', '<x/>')).rejects.toMatchObject({ kind: 'http', message: expect.stringMatching(/redirects are not followed/) });
      await expect(post(`${base}/huge`, 'a', '<x/>')).rejects.toMatchObject({ message: expect.stringMatching(/larger than 20 MB/) });
      // Guarded mode: a public-looking name that resolves to a private address never connects.
      const guarded = httpPost({ resolver: ((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as never, timeoutMs: 2000 });
      await expect(guarded('https://ps.supplier-looks-public.com/x', 'a', '<x/>')).rejects.toMatchObject({ kind: 'network' });
    } finally {
      srv.close();
    }
  });
});

describe('whole-catalog fetch', () => {
  it('imports what it can map, reports what it cannot, and prices from the cheapest part', async () => {
    const calls: Record<string, number> = {};
    const r = await fetchSupplierCatalog(fakeSupplier({ calls }), { endpoints: ENDPOINTS, credentials: FAKE_CREDENTIALS, currency: 'USD' });

    expect(r.imported.map((i) => i.supplierProductId).sort()).toEqual(['PS-TEE-100', 'PS-TUM-20']);
    const tee = r.imported.find((i) => i.supplierProductId === 'PS-TEE-100')!.product;
    expect(tee).toMatchObject({ slug: 'supplier-heavy-cotton-tee', template: 'tee', category: 'Apparel', brand: 'Acme Apparel', traits: { isApparel: true }, blankBase: 410 });
    expect(tee.breaks).toEqual([
      { minQty: 24, blankUnitCost: 410 },
      { minQty: 72, blankUnitCost: 346 },
      { minQty: 144, blankUnitCost: 320 },
    ]);
    expect(tee.colors).toEqual([
      { name: 'Black', hex: '#000000', isDark: true },
      { name: 'White', hex: '#FFFFFF', isDark: false },
    ]);
    expect(tee.methods).toEqual([
      { method: 'screen_print', location: 'full_front', w: 12, h: 14 },
      { method: 'dtg', location: 'full_front', w: 12, h: 14 },
      { method: 'embroidery', location: 'left_chest', w: 4, h: 4 },
    ]);

    const tum = r.imported.find((i) => i.supplierProductId === 'PS-TUM-20')!.product;
    expect(tum).toMatchObject({ template: 'tumbler', traits: { isHardGood: true, isEco: true } });
    expect(tum.breaks).toEqual([
      { minQty: 48, blankUnitCost: 825 },
      { minQty: 144, blankUnitCost: 750 },
    ]);
    expect(tum.colors[0]).toEqual({ name: 'Stainless', hex: '#B8BCC0', isDark: false });
    expect(tum.methods).toEqual([
      { method: 'laser_engraving', location: 'one_side', w: 3, h: 2.5 },
      { method: 'laser_engraving', location: 'wrap', w: 8, h: 2.5 },
    ]);

    expect(r.skipped).toEqual([{ supplierProductId: 'PS-USB-8', reason: expect.stringMatching(/no product template fits "USB Drives"/) }]);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Supplier Heavy Cotton Tee.*without a hex value left out: Athletic Heather/),
        expect.stringMatching(/Supplier Heavy Cotton Tee.*no matching print area left out: Sleeve/),
        expect.stringMatching(/Tumbler.*not supported left out: 4CP Full Color/),
      ]),
    );
    expect(r.failed).toEqual([]);
    expect(r.remaining).toBe(0);
    // Decorated configuration fetched only for the tumbler, whose Blank response had no locations.
    expect(calls).toEqual({ getProductSellable: 1, getProduct: 3, getFobPoints: 3, getConfigurationAndPricing: 4 });
  });

  it('one failing product is reported; the rest still import', async () => {
    const r = await fetchSupplierCatalog(fakeSupplier({ faultOn: 'PS-TEE-100' }), { endpoints: ENDPOINTS, credentials: FAKE_CREDENTIALS, currency: 'USD' });
    expect(r.failed).toEqual([{ supplierProductId: 'PS-TEE-100', error: expect.stringMatching(/fault: Internal error for PS-TEE-100/) }]);
    expect(r.imported.map((i) => i.supplierProductId)).toEqual(['PS-TUM-20']);
  });

  it('bad credentials stop the run at the first call', async () => {
    const calls: Record<string, number> = {};
    await expect(fetchSupplierCatalog(fakeSupplier({ calls }), { endpoints: ENDPOINTS, credentials: { id: 'acme-dist', password: 'nope' }, currency: 'USD' })).rejects.toMatchObject({ kind: 'service', code: '105' });
    expect(calls).toEqual({ getProductSellable: 1 });
    // ...and when products are listed explicitly, it still stops after the first product fails.
    const calls2: Record<string, number> = {};
    await expect(
      fetchSupplierCatalog(fakeSupplier({ calls: calls2 }), { endpoints: ENDPOINTS, credentials: { id: 'x', password: 'y' }, currency: 'USD', productIds: ['PS-TEE-100', 'PS-TUM-20', 'PS-USB-8'], concurrency: 1 }),
    ).rejects.toBeInstanceOf(SoapError);
    expect(calls2).toEqual({ getProduct: 1 });
  });

  it('honours picks, overrides, caps and currency', async () => {
    const r = await fetchSupplierCatalog(fakeSupplier(), {
      endpoints: ENDPOINTS,
      credentials: FAKE_CREDENTIALS,
      currency: 'USD',
      productIds: ['PS-USB-8'],
      templateOverrides: { 'PS-USB-8': 'journal' },
    });
    // The distributor chose a template the rules couldn't: now it imports, on that template's zone.
    expect(r.skipped).toEqual([]);
    expect(r.imported[0]!.product).toMatchObject({ template: 'journal', traits: { isHardGood: true }, methods: [{ method: 'pad_printing', location: 'front_cover', w: 1, h: 0.5 }] });

    const capped = await fetchSupplierCatalog(fakeSupplier(), { endpoints: ENDPOINTS, credentials: FAKE_CREDENTIALS, currency: 'USD', maxProducts: 1 });
    expect(capped.imported.length + capped.skipped.length + capped.failed.length).toBe(1);
    expect(capped.remaining).toBe(2);

    const cad = await fetchSupplierCatalog(fakeSupplier(), { endpoints: ENDPOINTS, credentials: FAKE_CREDENTIALS, currency: 'CAD', productIds: ['PS-TEE-100'] });
    expect(cad.skipped[0]!.reason).toMatch(/priced in USD, not CAD/);
  });
});
