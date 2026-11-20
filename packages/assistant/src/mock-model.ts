import { detectLanguage, type Language } from './language.js';
import type { ChatModel, FinalAnswer, ModelContent, ModelRequest, ModelResponse } from './model.js';

/**
 * Scripted, deterministic model for mock mode and tests. It reads the request
 * the live model would get (passages from the tagged block, tool results from
 * the messages) and follows the same protocol: tool calls first, then a final
 * answer. Same request, same response. It is a stand-in for wiring, not for
 * quality: the evals (phase 8) measure the real model.
 */

const ORDER_NUMBER = /\b[A-Z]{2,4}[- ]?\d{3,6}\b/i;
const WANTS_PERSON =
  /\b(person|human|agent|someone|staff|manager|insaan|aadmi|kisi se baat)\b|شخص|موظف|إنسان|ആൾ|ആളുമായി|व्यक्ति|इंसान/iu;
const OFF_TOPIC =
  /\b(poem|essay|homework|python|javascript|code|joke|weather|cricket|recipe|translate|story)\b/i;

type OrderStatus = 'received' | 'preparing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';

interface OrderResult {
  found: boolean;
  order_number?: string;
  status?: OrderStatus;
  courier?: string | null;
  promised_date?: string | null;
}

const STATUS: Record<Language, Record<OrderStatus, string>> = {
  en: {
    received: 'received',
    preparing: 'being prepared',
    ready: 'ready for pickup',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
  },
  hi: {
    received: 'प्राप्त हो गया है',
    preparing: 'तैयार किया जा रहा है',
    ready: 'पिकअप के लिए तैयार है',
    shipped: 'भेज दिया गया है',
    delivered: 'डिलीवर हो गया है',
    cancelled: 'रद्द कर दिया गया है',
  },
  'hi-Latn': {
    received: 'mil gaya hai',
    preparing: 'taiyaar ho raha hai',
    ready: 'pickup ke liye taiyaar hai',
    shipped: 'bhej diya gaya hai',
    delivered: 'deliver ho gaya hai',
    cancelled: 'cancel ho gaya hai',
  },
  ml: {
    received: 'ലഭിച്ചു',
    preparing: 'തയ്യാറാക്കിക്കൊണ്ടിരിക്കുന്നു',
    ready: 'പിക്കപ്പിന് തയ്യാറാണ്',
    shipped: 'അയച്ചു',
    delivered: 'ഡെലിവർ ചെയ്തു',
    cancelled: 'റദ്ദാക്കി',
  },
  ar: {
    received: 'تم استلامه',
    preparing: 'قيد التحضير',
    ready: 'جاهز للاستلام',
    shipped: 'تم شحنه',
    delivered: 'تم توصيله',
    cancelled: 'تم إلغاؤه',
  },
};

const TEXT: Record<
  Language,
  {
    order: (n: string, status: string) => string;
    courier: (c: string) => string;
    date: (d: string) => string;
    noDate: string;
    orderNotFound: (n: string) => string;
    notFound: string;
    decline: (business: string) => string;
    handedOff: string;
  }
> = {
  en: {
    order: (n, s) => `Order ${n} is ${s}.`,
    courier: (c) => ` Courier: ${c}.`,
    date: (d) => ` Expected by ${d}.`,
    noDate: " We don't have a delivery date yet.",
    orderNotFound: (n) =>
      `I couldn't find order ${n} for this number. Shall I connect you with a person?`,
    notFound: "I don't have that information. Shall I connect you with a person from our team?",
    decline: (b) => `Sorry, I can only help with questions about ${b}.`,
    handedOff: 'A person from our team will reply here soon.',
  },
  hi: {
    order: (n, s) => `ऑर्डर ${n} ${s}।`,
    courier: (c) => ` कूरियर: ${c}।`,
    date: (d) => ` अपेक्षित तारीख: ${d}।`,
    noDate: ' अभी डिलीवरी की तारीख तय नहीं है।',
    orderNotFound: (n) => `मुझे इस नंबर के लिए ऑर्डर ${n} नहीं मिला। क्या मैं आपको किसी व्यक्ति से जोड़ दूँ?`,
    notFound: 'मेरे पास यह जानकारी नहीं है। क्या मैं आपको हमारी टीम के किसी व्यक्ति से जोड़ दूँ?',
    decline: (b) => `माफ़ कीजिए, मैं केवल ${b} से जुड़े सवालों में मदद कर सकता हूँ।`,
    handedOff: 'हमारी टीम का कोई व्यक्ति जल्द ही यहाँ जवाब देगा।',
  },
  'hi-Latn': {
    order: (n, s) => `Order ${n} ${s}.`,
    courier: (c) => ` Courier: ${c}.`,
    date: (d) => ` Expected date: ${d}.`,
    noDate: ' Delivery ki date abhi tay nahi hai.',
    orderNotFound: (n) =>
      `Is number ke liye order ${n} nahi mila. Kya main aapko kisi se connect kar doon?`,
    notFound:
      'Mere paas yeh jaankari nahi hai. Kya main aapko hamari team se kisi se connect kar doon?',
    decline: (b) => `Sorry, main sirf ${b} se jude sawaalon mein madad kar sakta hoon.`,
    handedOff: 'Hamari team se koi jaldi hi yahan reply karega.',
  },
  ml: {
    order: (n, s) => `ഓർഡർ ${n} ${s}.`,
    courier: (c) => ` കൊറിയർ: ${c}.`,
    date: (d) => ` പ്രതീക്ഷിക്കുന്ന തീയതി: ${d}.`,
    noDate: ' ഡെലിവറി തീയതി ഇതുവരെ ലഭ്യമല്ല.',
    orderNotFound: (n) => `ഈ നമ്പറിൽ ഓർഡർ ${n} കണ്ടെത്താനായില്ല. ഞങ്ങളുടെ ടീമിലെ ഒരാളുമായി ബന്ധിപ്പിക്കട്ടെ?`,
    notFound: 'ആ വിവരം എന്റെ പക്കൽ ഇല്ല. ഞങ്ങളുടെ ടീമിലെ ഒരാളുമായി ബന്ധിപ്പിക്കട്ടെ?',
    decline: (b) => `ക്ഷമിക്കണം, ${b}-നെക്കുറിച്ചുള്ള ചോദ്യങ്ങളിൽ മാത്രമേ എനിക്ക് സഹായിക്കാൻ കഴിയൂ.`,
    handedOff: 'ഞങ്ങളുടെ ടീമിലെ ഒരാൾ ഉടൻ ഇവിടെ മറുപടി നൽകും.',
  },
  ar: {
    order: (n, s) => `الطلب ${n} ${s}.`,
    courier: (c) => ` شركة الشحن: ${c}.`,
    date: (d) => ` الموعد المتوقع: ${d}.`,
    noDate: ' لا يوجد موعد توصيل محدد بعد.',
    orderNotFound: (n) =>
      `لم أجد الطلب ${n} المرتبط بهذا الرقم. هل تريد أن أوصلك بأحد أعضاء فريقنا؟`,
    notFound: 'ليست لدي هذه المعلومة. هل تريد أن أوصلك بأحد أعضاء فريقنا؟',
    decline: (b) => `عذرًا، يمكنني المساعدة فقط في الأسئلة المتعلقة بـ ${b}.`,
    handedOff: 'سيرد عليك أحد أعضاء فريقنا هنا قريبًا.',
  },
};

function unescape(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function textOf(blocks: readonly ModelContent[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** The answer part of the top passage, cut at a sentence end near 300 characters. */
function quote(passage: string): string {
  const answer = passage.replace(/^Q:[\s\S]*?\nA:\s*/, '').trim();
  if (answer.length <= 300) return answer;
  const cut = answer.slice(0, 300);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

export class MockChatModel implements ChatModel {
  readonly name = 'mock';

  complete(request: ModelRequest): Promise<ModelResponse> {
    const result = this.decide(request);
    const inputChars =
      request.system.length +
      request.messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    const output = JSON.stringify(result);
    return Promise.resolve({
      model: this.name,
      // About four characters per token; the mock has no tokenizer.
      usage: {
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: Math.ceil(output.length / 4),
      },
      result,
    });
  }

  private decide(request: ModelRequest): ModelResponse['result'] {
    const business = /assistant for (.+?)\./.exec(request.system)?.[1] ?? 'this business';
    const lastCustomerTurn = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'));
    const turnText = lastCustomerTurn ? textOf(lastCustomerTurn.content) : '';
    const customer = [...turnText.matchAll(/<customer_message>\n([\s\S]*?)\n<\/customer_message>/g)]
      .map((m) => unescape(m[1] ?? ''))
      .join('\n');
    const language = detectLanguage(customer);
    const t = TEXT[language];
    const answer = (a: FinalAnswer) => ({ type: 'answer' as const, answer: a });

    // After a tool call: answer from its result.
    const last = request.messages.at(-1);
    const toolResult = last?.content.find((b) => b.type === 'tool_result');
    if (toolResult) {
      const call = request.messages
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_use' && b.id === toolResult.toolUseId);
      const name = call?.type === 'tool_use' ? call.name : '';
      if (name === 'handoff') return answer({ reply: t.handedOff, basis: 'none' });
      const order = JSON.parse(toolResult.content) as OrderResult;
      const input = call?.type === 'tool_use' ? (call.input as { order_number?: unknown }) : {};
      const asked = typeof input.order_number === 'string' ? input.order_number : '';
      if (!order.found || !order.status) {
        return answer({ reply: t.orderNotFound(asked), basis: 'none' });
      }
      let reply = t.order(order.order_number ?? asked, STATUS[language][order.status]);
      if (order.courier) reply += t.courier(order.courier);
      if (order.status !== 'delivered' && order.status !== 'cancelled') {
        reply += order.promised_date ? t.date(order.promised_date) : t.noDate;
      }
      return answer({ reply, basis: 'order' });
    }

    const used = request.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use');
    const id = `toolu_mock_${String(used.length + 1)}`;
    if (WANTS_PERSON.test(customer)) {
      return {
        type: 'tool_calls',
        calls: [
          {
            id,
            name: 'handoff',
            input: { reason: 'asked_for_person', summary: 'Customer asked for a person.' },
          },
        ],
      };
    }
    const orderNumber = ORDER_NUMBER.exec(customer)?.[0];
    if (orderNumber) {
      return {
        type: 'tool_calls',
        calls: [{ id, name: 'lookup_order', input: { order_number: orderNumber } }],
      };
    }
    if (OFF_TOPIC.test(customer)) return answer({ reply: t.decline(business), basis: 'declined' });

    const passage = /<passage id="P1"[^>]*>\n([\s\S]*?)\n<\/passage>/.exec(turnText)?.[1];
    if (passage) return answer({ reply: quote(unescape(passage)), basis: 'knowledge' });
    return answer({ reply: t.notFound, basis: 'none' });
  }
}
