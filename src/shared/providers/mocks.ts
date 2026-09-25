import type {
  AssetRef,
  BackgroundRemovalProvider,
  CrmProvider,
  EmailMessage,
  EmailProvider,
  ImageGenerationProvider,
  LeadPayload,
  RenderRequest,
  StorageProvider,
  VisionAnalyzer,
  VisionResult,
} from './index';

/** In-memory storage — good enough for tests and local dev with no object store. */
export class MockStorageProvider implements StorageProvider {
  private store = new Map<string, { data: Uint8Array; contentType: string; tenantId: string }>();
  async put(key: string, data: Uint8Array, contentType: string, tenantId: string): Promise<AssetRef> {
    this.store.set(`${tenantId}:${key}`, { data, contentType, tenantId });
    return { id: key, url: `mock://asset/${tenantId}/${key}`, contentType, bytes: data.byteLength, tenantId };
  }
  async get(key: string, tenantId: string) {
    const o = this.store.get(`${tenantId}:${key}`);
    return o ? { data: o.data, contentType: o.contentType } : null;
  }
  async getUrl(key: string, tenantId: string): Promise<string> {
    if (!this.store.has(`${tenantId}:${key}`)) throw new Error('mock storage: not found (tenant-scoped)');
    return `mock://asset/${tenantId}/${key}`;
  }
  async delete(key: string, tenantId: string): Promise<void> {
    this.store.delete(`${tenantId}:${key}`);
  }
}

export class MockBackgroundRemovalProvider implements BackgroundRemovalProvider {
  async remove(input: AssetRef): Promise<AssetRef> {
    return { ...input, id: `${input.id}-nobg`, url: `${input.url}?nobg=1` };
  }
}

/** Heuristic zone from §3.3 defaults, with a generic fallback centroid. */
export class MockVisionAnalyzer implements VisionAnalyzer {
  private readonly productType: string;
  constructor(productType = 'tee') {
    this.productType = productType;
  }
  async analyze(): Promise<VisionResult> {
    const byType: Record<string, { label: string; bbox: [number, number, number, number] }> = {
      tee: { label: 'left_chest', bbox: [0.62, 0.28, 0.18, 0.18] },
      cap: { label: 'front_panel', bbox: [0.35, 0.40, 0.30, 0.20] },
      tumbler: { label: 'wrap_front', bbox: [0.30, 0.35, 0.40, 0.30] },
      tote: { label: 'center_front', bbox: [0.30, 0.35, 0.40, 0.35] },
    };
    const pick = byType[this.productType] ?? { label: 'generic_surface', bbox: [0.35, 0.35, 0.3, 0.3] };
    const [x, y, w, h] = pick.bbox;
    const zone = { label: pick.label, bbox: { x, y, w, h }, confidence: 0.82 };
    return { productType: this.productType, material: 'cotton', zones: [zone], bestZone: zone };
  }
}

/** Deterministic placeholder proof — stands in for the compositing/AI adapter (ADR 0004). */
export class MockImageGenerationProvider implements ImageGenerationProvider {
  async render(req: RenderRequest): Promise<AssetRef> {
    const id = `proof-${req.mode}-${req.method}-${req.zone.label}`;
    return {
      id,
      url: `mock://proof/${req.tenantId}/${id}`,
      contentType: 'image/png',
      bytes: 0,
      tenantId: req.tenantId,
    };
  }
}

/** Records leads instead of calling a real CRM. */
/** Captures messages (tests read sign-in links from here). */
export class MockEmailProvider implements EmailProvider {
  public readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
  }
}

/** Dev: prints the message so a developer can click the sign-in link from the terminal. */
export class LogEmailProvider implements EmailProvider {
  async send(msg: EmailMessage) {
    console.warn(`\n[email] to ${msg.to}: ${msg.subject}\n${msg.text}\n`);
  }
}

export class MockCrmProvider implements CrmProvider {
  public readonly received: LeadPayload[] = [];
  async route(lead: LeadPayload): Promise<{ id: string; routedTo: string }> {
    this.received.push(lead);
    return { id: `lead-${this.received.length}`, routedTo: 'mock' };
  }
}
