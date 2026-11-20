import { MockEmbedder, passageFromFaq, type Embedder, type PassageDraft } from '@app/assistant';
import { schema, type Database, type OrderItem } from '@app/db';
import {
  KNOWLEDGE_CONTENT_TYPES,
  knowledgeObjectKey,
  readKnowledgeFile,
  type ObjectStorage,
} from '@app/pipeline';
import { DEMO_BUSINESSES, DEMO_CUSTOMERS } from '@app/shared';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Knowledge, orders and assistant settings for the demo businesses. The facts
 * agree with the seeded conversations: KB-2291 shipped with Aramex and has no
 * delivery date, KB-2302 does not exist, screen guards carry no warranty,
 * eggless chocolate cake is ₹850 a kilo.
 */

interface SeedFile {
  title: string;
  content: string;
}

interface SeedKnowledge {
  summary: string;
  faqs: [question: string, answer: string][];
  files: SeedFile[];
}

const KNOWLEDGE: Record<string, SeedKnowledge> = {
  'qamar-phone-corner': {
    summary:
      'A phone and accessories shop in Al Karama, Dubai: new phones, covers, chargers, screen repairs and trade-ins.',
    faqs: [
      [
        'Is the screen guard covered by warranty?',
        "Screen guards and cases are not covered by warranty. Phones carry the manufacturer's 12-month warranty from the invoice date; keep the invoice.",
      ],
      [
        'Do you deliver?',
        'We deliver anywhere in Dubai the same day for orders placed before 4 pm. Delivery is free above AED 200; below that it is AED 15. Outside Dubai we ship with Aramex in 1 to 3 working days.',
      ],
      [
        'What are your opening hours?',
        'Every day from 10 am to 11 pm; on Friday from 2 pm to 11 pm. We are in Al Karama, next to Karama Centre.',
      ],
      [
        'Do you buy old phones?',
        'Yes. Bring the phone with its box and charger; we check it in the shop and give a price on the spot, paid by bank transfer or as store credit.',
      ],
      [
        'Do you repair screens?',
        'Yes, for Samsung, Apple and Google phones. Most screen repairs take 1 to 2 hours. The price depends on the model, so we quote in the shop.',
      ],
      [
        'How can I pay?',
        'Cash, card, Apple Pay or bank transfer. Tabby instalments are available on phones above AED 1,000.',
      ],
      ['هل يمكنني إرجاع الهاتف؟', 'نعم، خلال 14 يومًا إذا كان الهاتف غير مفتوح ومعه الفاتورة.'],
    ],
    files: [
      {
        title: 'Price list November.csv',
        content: [
          'Product,Brand,Storage,Price (AED),Colours',
          'Galaxy S24,Samsung,128 GB,2899,"Onyx Black, Marble Grey"',
          'Galaxy S24,Samsung,256 GB,3149,"Onyx Black, Marble Grey"',
          'Galaxy A55,Samsung,128 GB,1399,"Navy, Lilac"',
          'iPhone 16,Apple,128 GB,3399,"Black, White, Pink"',
          'iPhone 15,Apple,128 GB,2799,"Black, Blue"',
          'Pixel 9,Google,128 GB,3199,"Obsidian, Porcelain"',
          'Redmi Note 14,Xiaomi,256 GB,899,"Black, Blue"',
          'iPhone 15 silicone cover,Apple,,35,"Black, Clay"',
          'Tempered glass screen guard,Generic,,25,',
          'USB-C fast charger 25 W,Samsung,,79,White',
        ].join('\n'),
      },
      {
        title: 'Returns and exchanges.md',
        content: [
          '# Returns',
          'Unopened phones can be returned within 14 days with the invoice for a full refund.',
          'Opened phones can be exchanged within 7 days only if they are faulty; the brand service centre confirms the fault.',
          '',
          '# Accessories',
          'Accessories can be exchanged within 7 days if unused and in the original pack.',
          '',
          '# Refunds',
          'Card payments are refunded to the same card in 5 to 7 working days. Cash payments are refunded in cash.',
        ].join('\n'),
      },
    ],
  },
  'kayal-bakes': {
    summary:
      'A home bakery in Kaloor, Kochi, taking orders for cakes, cupcakes and plum cakes, for pickup or delivery in Kochi city.',
    faqs: [
      [
        'Do you have eggless cakes?',
        'Yes, every cake on the menu can be made eggless at no extra cost.',
      ],
      [
        'How early should I order?',
        'Order at least two days ahead: by Thursday 6 pm for a Saturday cake. Custom and tiered cakes need five days.',
      ],
      [
        'Can you write a message on the cake?',
        'Yes, a message on the cake is free, in English or Malayalam.',
      ],
      [
        'Do you deliver?',
        'We deliver within Kochi city (Kaloor, Edappally, Kadavanthra, Vyttila and Fort Kochi) for ₹80. Pickup from our kitchen in Kaloor is free, 10 am to 8 pm.',
      ],
      [
        'Do you make custom or wedding cakes?',
        'Yes. Custom, tiered and wedding cakes are quoted by our baker: send the details and a person will reply with a price.',
      ],
      ['ഓർഡർ റദ്ദാക്കാമോ?', 'ഡെലിവറിക്ക് 24 മണിക്കൂർ മുമ്പ് വരെ ഓർഡർ റദ്ദാക്കാം. അതിനുശേഷം റദ്ദാക്കാൻ കഴിയില്ല.'],
    ],
    files: [
      {
        title: 'Menu and prices.csv',
        content: [
          'Cake,Size,Price (INR),Eggless available',
          'Chocolate truffle,1 kg,850,Yes',
          'Black forest,1 kg,750,Yes',
          'Red velvet,1 kg,950,Yes',
          'Pineapple,1 kg,650,Yes',
          'Butterscotch,1 kg,700,Yes',
          'Plum cake,500 g,450,No',
          'Cupcakes,Box of 6,360,Yes',
          'Sugar-free cake (any flavour),500 g,550,Yes',
        ].join('\n'),
      },
    ],
  },
};

interface SeedOrder {
  customer: string;
  number: string;
  status: (typeof schema.orderStatus.enumValues)[number];
  items: OrderItem[];
  total: string;
  currency: string;
  courier?: string;
  trackingNumber?: string;
  /** Days from today; omitted means no date was promised. */
  promisedInDays?: number;
  placedDaysAgo: number;
}

const ORDERS: Record<string, SeedOrder[]> = {
  'qamar-phone-corner': [
    {
      customer: 'Fatima Al Mansoori',
      number: 'KB-2291',
      status: 'shipped',
      items: [{ name: 'Pixel 9 128 GB, Obsidian', quantity: 1 }],
      total: '3199.00',
      currency: 'AED',
      courier: 'Aramex',
      trackingNumber: '3398117781',
      placedDaysAgo: 6,
    },
    {
      customer: 'Mohammed Rafi',
      number: 'KB-2433',
      status: 'delivered',
      items: [{ name: 'Tempered glass screen guard', quantity: 2 }],
      total: '50.00',
      currency: 'AED',
      placedDaysAgo: 3,
    },
    {
      customer: 'Aisha Siddiqui',
      number: 'KB-2440',
      status: 'received',
      items: [{ name: 'Galaxy A55 128 GB, Navy', quantity: 1 }],
      total: '1399.00',
      currency: 'AED',
      promisedInDays: 2,
      placedDaysAgo: 0,
    },
  ],
  'kayal-bakes': [
    {
      customer: 'Sneha Kurian',
      number: 'KY-1187',
      status: 'preparing',
      items: [{ name: "Chocolate truffle 1 kg, eggless, 'Happy birthday Ammu'", quantity: 1 }],
      total: '850.00',
      currency: 'INR',
      promisedInDays: 1,
      placedDaysAgo: 1,
    },
    {
      customer: 'Joseph Mathew',
      number: 'KY-1175',
      status: 'received',
      items: [{ name: 'Red velvet 1 kg', quantity: 1 }],
      total: '950.00',
      currency: 'INR',
      promisedInDays: 2,
      placedDaysAgo: 2,
    },
  ],
};

const DAY = 24 * 60 * 60 * 1000;

async function seedSources(
  db: Database,
  storage: ObjectStorage,
  tenantId: string,
  knowledge: SeedKnowledge,
  embedder: Embedder,
): Promise<void> {
  const add = async (
    source: Omit<typeof schema.knowledgeSources.$inferInsert, 'tenantId'>,
    passages: PassageDraft[],
  ) => {
    const vectors = await embedder.embed(
      passages.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)),
      'document',
    );
    const [row] = await db
      .insert(schema.knowledgeSources)
      .values({ ...source, tenantId, status: 'ready', passageCount: passages.length })
      .returning({ id: schema.knowledgeSources.id });
    if (!row) throw new Error('seed: knowledge source insert returned no row');
    await db.insert(schema.knowledgePassages).values(
      passages.map((p, ordinal) => ({
        tenantId,
        sourceId: row.id,
        ordinal,
        heading: p.heading,
        text: p.text,
        embedding: vectors[ordinal] ?? [],
        embeddingModel: embedder.model,
      })),
    );
    return row.id;
  };

  for (const [question, answer] of knowledge.faqs) {
    await add({ kind: 'faq', title: question, answer }, [passageFromFaq(question, answer)]);
  }
  for (const file of knowledge.files) {
    const bytes = new TextEncoder().encode(file.content);
    // Read exactly as the worker reads an upload, so seeded passages match.
    const read = await readKnowledgeFile(bytes, file.title);
    const catalogue = file.title.endsWith('.csv');
    const contentType = KNOWLEDGE_CONTENT_TYPES[catalogue ? 'catalogue' : 'text'];
    const id = await add(
      {
        kind: catalogue ? 'catalogue' : 'file',
        title: file.title,
        contentType,
        sizeBytes: bytes.byteLength,
        unitCount: read.unitCount,
      },
      read.passages,
    );
    const key = knowledgeObjectKey(tenantId, id);
    await storage.put(key, bytes, contentType);
    await db
      .update(schema.knowledgeSources)
      .set({ storageKey: key })
      .where(eq(schema.knowledgeSources.id, id));
  }
}

async function seedOrders(db: Database, tenantId: string, orders: SeedOrder[], now: number) {
  for (const order of orders) {
    const demo = DEMO_CUSTOMERS.find((c) => c.name === order.customer);
    if (!demo) throw new Error(`seed: no demo customer ${order.customer}`);
    const [customer] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, tenantId), eq(schema.customers.bsuid, demo.bsuid)));
    await db.insert(schema.orders).values({
      tenantId,
      customerId: customer?.id ?? null,
      orderNumber: order.number,
      status: order.status,
      items: order.items,
      total: order.total,
      currency: order.currency,
      courier: order.courier ?? null,
      trackingNumber: order.trackingNumber ?? null,
      promisedDate:
        order.promisedInDays === undefined
          ? null
          : new Date(now + order.promisedInDays * DAY).toISOString().slice(0, 10),
      placedAt: new Date(now - order.placedDaysAgo * DAY),
    });
  }
}

/**
 * Seeds each demo business that has no knowledge yet. Run after the
 * conversations, so orders can belong to the seeded customers. Idempotent.
 */
export async function seedKnowledge(
  db: Database,
  storage: ObjectStorage,
  /** The app's embedder: the mock offline, Cohere in live mode, so retrieval can compare. */
  options: { now?: number; embedder?: Embedder } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  for (const business of DEMO_BUSINESSES) {
    const knowledge = KNOWLEDGE[business.slug];
    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, business.slug));
    if (!tenant || !knowledge) continue;
    const [existing] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.tenantId, tenant.id));
    if ((existing?.n ?? 0) > 0) continue;

    await db
      .update(schema.tenants)
      .set({ assistantSummary: knowledge.summary })
      .where(eq(schema.tenants.id, tenant.id));
    await seedSources(db, storage, tenant.id, knowledge, options.embedder ?? new MockEmbedder());
    await seedOrders(db, tenant.id, ORDERS[business.slug] ?? [], now);
  }
}
