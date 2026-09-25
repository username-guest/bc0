/**
 * A fake PromoStandards supplier (ADR 0017) for tests, the browser suite and local dev. It
 * answers Product Data 2.0.0 and PPC 1.0.0 SOAP requests in the shape the published schemas
 * describe, with the untidiness real suppliers have: a colour without a hex, a method we don't
 * support, a location we can't map, a product no template fits, and prices by the dozen.
 * It is not evidence that any particular supplier behaves this way.
 */
import type { SoapPost } from './soap';
import { child, esc, find, parseXml, text } from './xml';

export const FAKE_CREDENTIALS = { id: 'acme-dist', password: 'correct horse' };

interface FakeProduct {
  productId: string;
  name: string;
  brand: string;
  category: string;
  subCategory?: string;
  material?: string;
  colors: Array<{ name: string; hex?: string }>;
  /** [minQuantity, price, uom] */
  prices: Array<[number, string, string]>;
  /** Only on the Decorated configuration (to exercise the fallback). */
  decoratedOnly?: boolean;
  locations: Array<{ name: string; decorations: Array<{ name: string; w?: string; h?: string; uom?: string }> }>;
}

export const FAKE_PRODUCTS: FakeProduct[] = [
  {
    productId: 'PS-TEE-100',
    name: 'Supplier Heavy Cotton Tee',
    brand: 'Acme Apparel',
    category: 'Apparel',
    subCategory: 'T-Shirts',
    material: '100% cotton',
    colors: [
      { name: 'Black', hex: '000000' },
      { name: 'Athletic Heather' }, // no hex, not in the name table → left out with a note
      { name: 'White', hex: '#fff' },
    ],
    prices: [
      [24, '4.10', 'EA'],
      [72, '3.456', 'EA'],
      [144, '3.20', 'EA'],
    ],
    locations: [
      { name: 'Full Front', decorations: [{ name: 'Screen Print', w: '12', h: '14' }, { name: 'Direct to Garment (DTG)', w: '12', h: '14' }] },
      { name: 'Left Chest', decorations: [{ name: 'Embroidery', w: '4', h: '4' }] },
      { name: 'Sleeve', decorations: [{ name: 'Screen Print', w: '3', h: '3' }] }, // no zone → noted
    ],
  },
  {
    productId: 'PS-TUM-20',
    name: '20 oz Recycled Steel Tumbler',
    brand: 'Acme Drinkware',
    category: 'Drinkware',
    subCategory: 'Tumblers',
    material: 'recycled stainless steel',
    colors: [{ name: 'Stainless' }, { name: 'Navy', hex: '1B2A4A' }],
    prices: [
      [48, '99.00', 'DZ'], // $8.25 each
      [144, '90.00', 'DZ'], // $7.50 each
    ],
    decoratedOnly: true,
    locations: [
      { name: 'Side 1', decorations: [{ name: 'Laser Engraving', w: '76.2', h: '63.5', uom: 'MM' }, { name: '4CP Full Color', w: '3', h: '2.5' }] },
      { name: 'Wrap', decorations: [{ name: 'Laser Engraved', w: '8', h: '2.5' }] },
    ],
  },
  {
    productId: 'PS-USB-8',
    name: '8 GB Swivel USB Drive',
    brand: 'Acme Tech',
    category: 'Technology',
    subCategory: 'USB Drives',
    colors: [{ name: 'Black', hex: '000000' }],
    prices: [[100, '5.00', 'EA']],
    locations: [{ name: 'Front', decorations: [{ name: 'Pad Print', w: '1', h: '0.5' }] }],
  },
];

const envelope = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;

const msg = (code: string, description: string) =>
  `<ns2:ServiceMessageArray><ns2:ServiceMessage><ns2:code>${code}</ns2:code><ns2:description>${esc(description)}</ns2:description><ns2:severity>Error</ns2:severity></ns2:ServiceMessage></ns2:ServiceMessageArray>`;

export interface FakeSupplierOptions {
  /** Fail one product with a SOAP fault. */
  faultOn?: string;
  /** Count calls per action, for assertions. */
  calls?: Record<string, number>;
}

export function fakeSupplier(opts: FakeSupplierOptions = {}): SoapPost {
  return async (_url, action, xml) => {
    if (opts.calls) opts.calls[action] = (opts.calls[action] ?? 0) + 1;
    const req = child(parseXml(xml), 'Body')!.children[0]!;
    const id = text(req, 'id');
    const pw = text(req, 'password');
    const respName = req.name.replace(/Request$/, 'Response');
    if (id !== FAKE_CREDENTIALS.id || pw !== FAKE_CREDENTIALS.password) {
      return { status: 200, body: envelope(`<ns2:${respName} xmlns:ns2="urn:x">${msg('105', 'Authentication Credentials failed')}</ns2:${respName}>`) };
    }
    const productId = text(req, 'productId');
    const p = FAKE_PRODUCTS.find((x) => x.productId === productId);
    if (productId && productId === opts.faultOn) {
      return { status: 500, body: envelope(`<s:Fault><faultcode>s:Server</faultcode><faultstring>Internal error for ${esc(productId)}</faultstring></s:Fault>`) };
    }
    switch (action) {
      case 'getProductSellable':
        return {
          status: 200,
          body: envelope(
            `<ns2:GetProductSellableResponse xmlns:ns2="urn:pd" xmlns:ns3="urn:shar"><ns2:ProductSellableArray>` +
              FAKE_PRODUCTS.flatMap((x) =>
                x.colors.map((_, i) => `<ns2:ProductSellable><ns3:productId>${x.productId}</ns3:productId><ns3:partId>${x.productId}-${i}</ns3:partId></ns2:ProductSellable>`),
              ).join('') +
              `</ns2:ProductSellableArray></ns2:GetProductSellableResponse>`,
          ),
        };
      case 'getProduct': {
        if (!p) return { status: 200, body: envelope(`<ns2:GetProductResponse xmlns:ns2="urn:pd">${msg('130', 'Product Id not found')}</ns2:GetProductResponse>`) };
        const parts = p.colors
          .map(
            (c, i) =>
              `<ProductPart><partId>${p.productId}-${i}</partId><ColorArray><Color><colorName>${esc(c.name)}</colorName>${c.hex ? `<hex>${c.hex}</hex>` : ''}</Color></ColorArray></ProductPart>`,
          )
          .join('');
        return {
          status: 200,
          body: envelope(
            `<ns2:GetProductResponse xmlns:ns2="urn:pd"><ns2:Product><productId>${p.productId}</productId><productName>${esc(p.name)}</productName>` +
              `<description>${esc(p.name)} &amp; more.</description><productBrand>${esc(p.brand)}</productBrand>` +
              `<ProductCategoryArray><ProductCategory><category>${esc(p.category)}</category>${p.subCategory ? `<subCategory>${esc(p.subCategory)}</subCategory>` : ''}</ProductCategory></ProductCategoryArray>` +
              `${p.material ? `<primaryMaterial>${esc(p.material)}</primaryMaterial>` : ''}<ProductPartArray>${parts}</ProductPartArray><isCloseout>false</isCloseout></ns2:Product></ns2:GetProductResponse>`,
          ),
        };
      }
      case 'getFobPoints':
        return {
          status: 200,
          body: envelope(`<GetFobPointsResponse><FobPointArray><FobPoint><fobId>1</fobId><fobCity>Dallas</fobCity><fobPostalCode>75201</fobPostalCode></FobPoint></FobPointArray></GetFobPointsResponse>`),
        };
      case 'getConfigurationAndPricing': {
        if (!p) return { status: 200, body: envelope(`<GetConfigurationAndPricingResponse>${msg('130', 'Product Id not found')}</GetConfigurationAndPricingResponse>`) };
        const cfgType = text(req, 'configurationType');
        const showLocations = !p.decoratedOnly || cfgType === 'Decorated';
        const partArray =
          `<PartArray>` +
          p.colors
            .map(
              (_, i) =>
                `<Part><partId>${p.productId}-${i}</partId><PartPriceArray>` +
                // The last colour is a pricier "upsize"-style part, to prove we price from the cheapest.
                p.prices
                  .map(([q, price, uom]) => `<PartPrice><minQuantity>${q}</minQuantity><price>${i === p.colors.length - 1 && p.colors.length > 1 ? (Number(price) + 1).toFixed(2) : price}</price><priceUom>${uom}</priceUom></PartPrice>`)
                  .join('') +
                `</PartPriceArray></Part>`,
            )
            .join('') +
          `</PartArray>`;
        const locArray = showLocations
          ? `<LocationArray>` +
            p.locations
              .map(
                (l, li) =>
                  `<Location><locationId>${li}</locationId><locationName>${esc(l.name)}</locationName><DecorationArray>` +
                  l.decorations
                    .map(
                      (d, di) =>
                        `<Decoration><decorationId>${di}</decorationId><decorationName>${esc(d.name)}</decorationName>` +
                        `${d.w ? `<decorationWidth>${d.w}</decorationWidth>` : ''}${d.h ? `<decorationHeight>${d.h}</decorationHeight>` : ''}` +
                        `<decorationUom>${d.uom ?? 'IN'}</decorationUom><defaultDecoration>${di === 0}</defaultDecoration></Decoration>`,
                    )
                    .join('') +
                  `</DecorationArray><defaultLocation>${li === 0}</defaultLocation></Location>`,
              )
              .join('') +
            `</LocationArray>`
          : '';
        return {
          status: 200,
          body: envelope(
            `<GetConfigurationAndPricingResponse><Configuration>${partArray}${locArray}<productId>${p.productId}</productId><currency>USD</currency><priceType>${esc(text(req, 'priceType') ?? '')}</priceType></Configuration></GetConfigurationAndPricingResponse>`,
          ),
        };
      }
      default:
        return { status: 500, body: envelope(`<s:Fault><faultcode>s:Client</faultcode><faultstring>Unknown action ${esc(action)}</faultstring></s:Fault>`) };
    }
  };
}

/** For tests that need to see what was sent. */
export const requestField = (xml: string, name: string): string | undefined => find(parseXml(xml), name)?.text;

/**
 * Local dev and the browser suites: requests to this host go to the fake supplier; anything else
 * goes to `real`. `.example` is reserved (RFC 2606) and never resolves, so a real deployment
 * can't be routed here by accident, and production config doesn't enable it at all.
 */
export const FAKE_SUPPLIER_HOST = 'promostandards.example';
export const FAKE_ENDPOINTS = {
  productData: `https://${FAKE_SUPPLIER_HOST}/ProductData/v2`,
  pricing: `https://${FAKE_SUPPLIER_HOST}/PricingAndConfiguration/v1`,
};

export function withFakeSupplier(real: SoapPost, fake: SoapPost = fakeSupplier()): SoapPost {
  return (url, action, xml) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* the real transport reports bad URLs */
    }
    return host === FAKE_SUPPLIER_HOST ? fake(url, action, xml) : real(url, action, xml);
  };
}
