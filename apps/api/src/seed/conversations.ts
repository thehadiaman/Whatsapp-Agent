import { randomBytes, randomUUID } from 'node:crypto';
import { schema, type Database } from '@app/db';
import { mediaKey, type ObjectStorage } from '@app/pipeline';
import { mockVoiceNote, readOggOpus, VOICE_NOTE_MIME_TYPE, type SpokenLanguage } from '@app/voice';
import { DEMO_BUSINESSES, DEMO_CUSTOMERS } from '@app/shared';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Realistic conversation history for the demo businesses: five languages,
 * every ownership state, notes, a closed window and a long message. Times
 * are minutes before "now" so the demo looks alive whenever it is seeded.
 * Fictional people and orders.
 */

type Step =
  | { in: string; at: number }
  /** A voice note, already transcribed (mock: the simulator's transcript). */
  | { voice: string; language: SpokenLanguage; at: number }
  | {
      assistant: string;
      at: number;
      status?: 'delivered' | 'read';
      /** A spoken reply that went as text because the language has no voice. */
      noVoice?: SpokenLanguage;
    }
  | { staff: string; by: string; at: number; status?: 'delivered' | 'read' }
  | {
      state: 'waiting_for_human' | 'human' | 'closed' | 'assistant';
      by: string;
      reason: string;
      at: number;
    }
  | { note: string; by: string; at: number };

interface Script {
  customer: string;
  steps: Step[];
}

const LONG_ORDER =
  "Hello, I'd like to order a cake for my parents' 40th wedding anniversary on Sunday the 30th. " +
  'There will be about 45 guests, mostly family, and several of them are elderly, so please keep it soft and not too sweet. ' +
  'We would like two tiers: the bottom tier in vanilla with a pineapple filling, and the top tier in eggless chocolate, because my aunt and her family do not eat eggs. ' +
  'For the decoration, my mother loves jasmine, so if you can do small white sugar flowers in that style around the edge it would mean a lot to her. ' +
  "On top, please write 'Happy 40th, Achan and Amma' in gold, in English, not Malayalam, because my cousins from abroad will be there too. " +
  'We do not want fondant; my father dislikes it. Whipped cream or buttercream is fine, whichever holds up better in the heat, since the function is in a hall without air conditioning until the evening. ' +
  'Can you also make 20 cupcakes in the same flavours, half and half, for the children? They can be simpler, with just a small flower on each. ' +
  'Delivery would be to St. Mary’s Parish Hall in Kaloor by 5:30 pm. If delivery is not possible we can pick it up from your shop by 4 pm, but I would prefer delivery because the cake is large and we are travelling by auto. ' +
  'Please tell me the total price including delivery, how much advance you need, and whether you accept UPI. ' +
  'Also, if there is any problem with the jasmine design, please call me before changing it instead of choosing something else. ' +
  'One more thing: my uncle is diabetic, so if you can make a small separate sugar-free cake, maybe half a kilo, in any flavour you recommend, please add it to the order and tell me the price separately. ' +
  'We will also need a cake knife and candles in the shape of the numbers 4 and 0, if you sell them; if not, no problem, we will buy them elsewhere. ' +
  'My phone is the same as this WhatsApp number. I am free after 6 pm on weekdays and anytime on Saturday. Thank you so much, we have ordered from you for every birthday and it is always perfect. Please confirm by message.';

/** Exported for the test that keeps it at least 2,000 characters (DESIGN.md states). */
export { LONG_ORDER };

const SCRIPTS: Record<string, Script[]> = {
  'qamar-phone-corner': [
    {
      customer: 'Fatima Al Mansoori',
      steps: [
        { in: 'هل وصل طلبي؟ رقم الطلب KB-2291', at: 42 },
        {
          assistant:
            'تم شحن طلبك KB-2291 يوم 15 نوفمبر مع أرامكس. لم تحدد شركة الشحن موعد التسليم بعد.',
          at: 42,
          status: 'read',
        },
        { in: 'أريد التحدث مع شخص', at: 36 },
        {
          state: 'waiting_for_human',
          by: 'assistant',
          reason: 'Customer asked for a person',
          at: 36,
        },
        { state: 'human', by: 'priya@qamar.example', reason: 'Taken over', at: 34 },
        {
          staff: 'مرحباً فاطمة، أتحقق من شركة الشحن الآن.',
          by: 'priya@qamar.example',
          at: 33,
          status: 'read',
        },
        {
          note: 'Aramex AWB ends 7781. Called them at 2:31; they say delivery tomorrow before noon.',
          by: 'priya@qamar.example',
          at: 31,
        },
      ],
    },
    {
      customer: 'Rahul Nair',
      steps: [
        { in: 'ഞാൻ ഓർഡർ ചെയ്ത ഫോൺ കവർ ഇതുവരെ എത്തിയില്ല. ഓർഡർ നമ്പർ KB-2302', at: 9 },
        {
          assistant:
            'ക്ഷമിക്കണം, KB-2302 എന്ന ഓർഡർ എനിക്ക് കണ്ടെത്താനായില്ല. ഞാൻ ഒരു സഹപ്രവർത്തകനെ ഏൽപ്പിക്കാം.',
          at: 9,
          status: 'delivered',
        },
        { state: 'waiting_for_human', by: 'assistant', reason: 'Order not found', at: 9 },
      ],
    },
    {
      customer: 'Mohammed Rafi',
      steps: [
        { in: 'bhai screen guard ka warranty kitna hai?', at: 18 },
        {
          assistant:
            'Screen guard par warranty nahi hoti. Phone par 12 mahine ki manufacturer warranty hai; invoice sambhal ke rakhiye.',
          at: 18,
          status: 'read',
        },
        { in: 'ok thanks', at: 17 },
      ],
    },
    {
      customer: 'Aisha Siddiqui',
      steps: [
        { in: 'Is the Galaxy S24 in stock in blue?', at: 25 },
        {
          assistant:
            "I don't have live stock levels for that model, so I can't confirm it. Would you like someone from the shop to check?",
          at: 25,
          status: 'delivered',
        },
      ],
    },
    {
      customer: 'Deepak Sharma',
      steps: [
        { in: 'क्या आपके पास iPhone 15 का कवर है?', at: 70 },
        {
          assistant: 'मेरे पास अभी स्टॉक की जानकारी नहीं है। मैं आपको दुकान के किसी व्यक्ति से जोड़ता हूँ।',
          at: 70,
          status: 'read',
        },
        {
          state: 'waiting_for_human',
          by: 'assistant',
          reason: 'Not in the knowledge base',
          at: 69,
        },
        { state: 'human', by: 'anil@qamar.example', reason: 'Taken over', at: 60 },
        {
          staff: 'जी हाँ, सिलिकॉन कवर 35 दिरहम में है। आज शाम तक आपके लिए रख दूँ?',
          by: 'anil@qamar.example',
          at: 59,
          status: 'read',
        },
        { in: 'हाँ, शाम 7 बजे आऊँगा', at: 57 },
      ],
    },
  ],
  'kayal-bakes': [
    {
      customer: 'Sneha Kurian',
      steps: [
        { in: 'Do you have eggless chocolate cake for Saturday?', at: 12 },
        {
          assistant:
            'Yes. Eggless chocolate is ₹850 for 1 kg. Please order by Thursday 6 pm for Saturday.',
          at: 12,
          status: 'read',
        },
        { in: "Can you write 'Happy birthday Ammu' on it?", at: 10 },
        {
          assistant:
            "Yes, a message on the cake is free. I'll note 'Happy birthday Ammu' when you place the order.",
          at: 10,
          status: 'delivered',
        },
        // "There's no egg in this cake, right?"
        { voice: 'ഈ കേക്കിൽ മുട്ട ഇല്ലല്ലോ, അല്ലേ?', language: 'ml', at: 4 },
        {
          // "No, the eggless chocolate cake has no egg."
          assistant: 'ഇല്ല, എഗ്ഗ്‌ലെസ് ചോക്ലേറ്റ് കേക്കിൽ മുട്ട ഇല്ല.',
          at: 4,
          status: 'delivered',
          noVoice: 'ml',
        },
      ],
    },
    {
      customer: 'Joseph Mathew',
      steps: [
        { in: 'ശനിയാഴ്ചത്തെ കേക്ക് ഓർഡറിന്റെ തീയതി മാറ്റാമോ?', at: 27 * 60 },
        { assistant: 'തീയതി മാറ്റാൻ ഞാൻ ഒരു സഹപ്രവർത്തകനെ ഏൽപ്പിക്കാം.', at: 27 * 60, status: 'read' },
        {
          state: 'waiting_for_human',
          by: 'assistant',
          reason: 'Order changes need a person',
          at: 27 * 60 - 1,
        },
        { state: 'human', by: 'nikhil@kayal.example', reason: 'Taken over', at: 26 * 60 + 30 },
        {
          staff: 'Sure, which date would you like instead?',
          by: 'nikhil@kayal.example',
          at: 26 * 60 + 25,
          status: 'delivered',
        },
        {
          note: 'He may want Sunday 2 pm; the oven is free then. Window has closed, so send the reopen template.',
          by: 'nikhil@kayal.example',
          at: 26 * 60,
        },
      ],
    },
    {
      customer: 'Lakshmi Menon',
      steps: [
        { in: LONG_ORDER, at: 5 },
        {
          assistant:
            "Thank you. Custom wedding cakes need a person to quote, so I've passed this to the team.",
          at: 5,
          status: 'delivered',
        },
        {
          state: 'waiting_for_human',
          by: 'assistant',
          reason: 'Custom order needs a quote',
          at: 5,
        },
      ],
    },
  ],
};

const wamid = () => `wamid.SEED${randomBytes(12).toString('base64url')}`;
const minutesAgo = (now: number, m: number) => new Date(now - m * 60_000);

async function nextNumber(db: Database, tenantId: string): Promise<number> {
  const [row] = await db
    .update(schema.tenants)
    .set({ nextConversationNumber: sql`${schema.tenants.nextConversationNumber} + 1` })
    .where(eq(schema.tenants.id, tenantId))
    .returning({ next: schema.tenants.nextConversationNumber });
  if (!row) throw new Error('seed: tenant not found');
  return row.next - 1;
}

async function writeScript(
  db: Database,
  ctx: {
    tenantId: string;
    channelId: string;
    customerId: string;
    users: Map<string, string>;
    storage: ObjectStorage;
  },
  steps: Step[],
  now: number,
): Promise<void> {
  const userId = (email: string) => {
    const id = ctx.users.get(email);
    if (!id) throw new Error(`seed: unknown staff ${email}`);
    return id;
  };
  let state: 'assistant' | 'waiting_for_human' | 'human' | 'closed' = 'assistant';
  let holder: string | null = null;
  let lastInbound: Date | null = null;
  let lastMessage: Date | null = null;
  for (const step of steps) {
    if ('state' in step) {
      state = step.state;
      holder = step.state === 'human' ? userId(step.by) : null;
    }
  }
  const first = steps[0];
  const startedAt = minutesAgo(now, first ? first.at : 0);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      tenantId: ctx.tenantId,
      channelId: ctx.channelId,
      customerId: ctx.customerId,
      number: await nextNumber(db, ctx.tenantId),
      state,
      holderUserId: holder,
      createdAt: startedAt,
    })
    .returning();
  if (!conversation) throw new Error('seed: conversation insert failed');

  await db.insert(schema.conversationTransitions).values({
    tenantId: ctx.tenantId,
    conversationId: conversation.id,
    fromState: null,
    toState: 'assistant',
    actorType: 'system',
    reason: 'Customer started a conversation',
    createdAt: startedAt,
  });

  let seq = 1;
  let current: typeof state = 'assistant';
  for (const step of steps) {
    const at = minutesAgo(now, step.at);
    const base = {
      tenantId: ctx.tenantId,
      channelId: ctx.channelId,
      conversationId: conversation.id,
    };
    if ('voice' in step) {
      // The file the simulator would have sent, in our storage like any voice note.
      const id = randomUUID();
      const bytes = mockVoiceNote({ text: step.voice, language: step.language });
      const key = mediaKey(ctx.tenantId, id);
      await ctx.storage.put(key, bytes, VOICE_NOTE_MIME_TYPE);
      await db.insert(schema.messages).values({
        ...base,
        id,
        direction: 'inbound',
        kind: 'audio',
        senderType: 'customer',
        waMessageId: wamid(),
        media: {
          id: `seed-${id}`,
          mimeType: VOICE_NOTE_MIME_TYPE,
          sha256: null,
          caption: null,
          voice: true,
          storageKey: key,
          sizeBytes: bytes.byteLength,
          durationMs: readOggOpus(bytes).durationMs,
        },
        transcript: {
          status: 'done',
          text: step.voice,
          language: step.language,
          engine: 'simulator',
          confidence: null,
        },
        status: 'received',
        statusAt: at,
        waTimestamp: at,
        createdAt: at,
      });
      lastInbound = at;
      lastMessage = at;
    } else if ('in' in step) {
      await db.insert(schema.messages).values({
        ...base,
        direction: 'inbound',
        kind: 'text',
        senderType: 'customer',
        waMessageId: wamid(),
        body: step.in,
        status: 'received',
        statusAt: at,
        waTimestamp: at,
        createdAt: at,
      });
      lastInbound = at;
      lastMessage = at;
    } else if ('assistant' in step || 'staff' in step) {
      const isStaff = 'staff' in step;
      await db.insert(schema.messages).values({
        ...base,
        direction: 'outbound',
        kind: 'text',
        senderType: isStaff ? 'user' : 'assistant',
        senderUserId: isStaff ? userId(step.by) : null,
        waMessageId: wamid(),
        body: isStaff ? step.staff : step.assistant,
        speech:
          !isStaff && step.noVoice
            ? { language: step.noVoice, voiceId: null, fallback: 'no_voice' }
            : null,
        status: step.status ?? 'delivered',
        statusAt: at,
        outboxSeq: seq++,
        attempts: 1,
        sentAt: at,
        createdAt: at,
      });
      lastMessage = at;
    } else if ('state' in step) {
      const actorIsUser = step.by.includes('@');
      await db.insert(schema.conversationTransitions).values({
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        fromState: current,
        toState: step.state,
        actorType: actorIsUser ? 'user' : step.by === 'assistant' ? 'assistant' : 'system',
        actorUserId: actorIsUser ? userId(step.by) : null,
        reason: step.reason,
        createdAt: at,
      });
      current = step.state;
    } else {
      await db.insert(schema.conversationNotes).values({
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        authorUserId: userId(step.by),
        body: step.note,
        createdAt: at,
      });
    }
  }

  await db
    .update(schema.conversations)
    .set({ lastInboundAt: lastInbound, lastMessageAt: lastMessage, nextOutboxSeq: seq })
    .where(eq(schema.conversations.id, conversation.id));
}

async function upsertCustomer(
  db: Database,
  tenantId: string,
  customer: { name: string; bsuid: string; waId: string | null },
): Promise<string> {
  const [row] = await db
    .insert(schema.customers)
    .values({ tenantId, bsuid: customer.bsuid, waId: customer.waId, profileName: customer.name })
    .onConflictDoUpdate({
      target: [schema.customers.tenantId, schema.customers.bsuid],
      set: { profileName: customer.name },
    })
    .returning({ id: schema.customers.id });
  if (!row) throw new Error('seed: customer upsert failed');
  return row.id;
}

// Names and openings for the optional long-list seed (SEED_BULK_CONVERSATIONS).
const FIRST = [
  'Ayesha',
  'Rohan',
  'Meera',
  'Omar',
  'Sanjay',
  'Noura',
  'Arjun',
  'Fathima',
  'Vikram',
  'Hessa',
  'Kiran',
  'Yusuf',
  'Anjali',
  'Khalid',
  'Divya',
  'Salim',
];
const LAST = [
  'Pillai',
  'Al Hashimi',
  'Iyer',
  'Khan',
  'Nair',
  'Al Suwaidi',
  'Menon',
  'Qureshi',
  'Reddy',
  'Thomas',
  'Varghese',
  'Bin Zayed',
];
const OPENINGS = [
  'Is the Redmi Note 14 available?',
  'هل لديكم شاحن سريع لهاتف سامسونج؟',
  'screen replacement kitne ka hai?',
  'ഈ ഫോണിന് വാറന്റി ഉണ്ടോ?',
  'क्या आज डिलीवरी हो सकती है?',
  'What time do you close today?',
  'Do you buy old phones?',
  'mera order kab aayega? KB-2417',
];

async function seedBulk(
  db: Database,
  ctx: { tenantId: string; channelId: string; users: Map<string, string>; storage: ObjectStorage },
  count: number,
  now: number,
): Promise<void> {
  const staff = [...ctx.users.keys()];
  for (let i = 0; i < count; i++) {
    const name =
      `${FIRST[i % FIRST.length] ?? 'Guest'} ${LAST[(i * 7) % LAST.length] ?? ''}`.trim();
    const customerId = await upsertCustomer(db, ctx.tenantId, {
      name,
      bsuid: `AE.5${String(i).padStart(19, '0')}`,
      waId: `9715${String(10_000_000 + i)}`,
    });
    const roll = i % 20;
    const at = 15 + i * 13; // spread over the last few days
    const steps: Step[] = [{ in: OPENINGS[i % OPENINGS.length] ?? 'Hello', at }];
    if (roll < 14) {
      steps.push({ assistant: 'Thanks for your message. Let me check that for you.', at: at - 1 });
    } else if (roll < 16) {
      steps.push({
        state: 'waiting_for_human',
        by: 'assistant',
        reason: 'Not in the knowledge base',
        at: at - 1,
      });
    } else if (roll < 19) {
      steps.push({
        state: 'human',
        by: staff[i % staff.length] ?? '',
        reason: 'Taken over',
        at: at - 1,
      });
    } else {
      steps.push({ state: 'closed', by: staff[0] ?? '', reason: 'Closed', at: at - 1 });
    }
    await writeScript(db, { ...ctx, customerId }, steps, now);
  }
}

/**
 * Seeds conversations for each demo business that has none yet. Idempotent:
 * a business with any conversation is left alone (`make reset` to start over).
 */
export async function seedConversations(
  db: Database,
  storage: ObjectStorage,
  options: { bulk: number; now?: number },
): Promise<void> {
  const now = options.now ?? Date.now();
  for (const business of DEMO_BUSINESSES) {
    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, business.slug));
    if (!tenant) continue;
    // Skip a business that has its scripted conversations already; the
    // generated history (customers HIST.*) does not count.
    const [existing] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.conversations)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.conversations.customerId))
      .where(
        and(
          eq(schema.conversations.tenantId, tenant.id),
          sql`coalesce(${schema.customers.bsuid}, '') not like 'HIST.%'`,
        ),
      );
    if ((existing?.n ?? 0) > 0) continue;
    const [channel] = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.tenantId, tenant.id));
    if (!channel) continue;
    const staffRows = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.tenantId, tenant.id));
    const users = new Map(staffRows.map((u) => [u.email, u.id]));

    for (const script of SCRIPTS[business.slug] ?? []) {
      const demo = DEMO_CUSTOMERS.find(
        (c) => c.name === script.customer && c.business === business.slug,
      );
      if (!demo) throw new Error(`seed: no demo customer ${script.customer}`);
      const customerId = await upsertCustomer(db, tenant.id, demo);
      await writeScript(
        db,
        { tenantId: tenant.id, channelId: channel.id, customerId, users, storage },
        script.steps,
        now,
      );
    }
    if (business.slug === 'qamar-phone-corner' && options.bulk > 0) {
      await seedBulk(
        db,
        { tenantId: tenant.id, channelId: channel.id, users, storage },
        options.bulk,
        now,
      );
    }
  }
}
