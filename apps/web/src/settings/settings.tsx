'use client';

import {
  assistantSettingsSchema,
  BUSINESS_LANGUAGES,
  businessSettingsSchema,
  escalationSettingsSchema,
  hoursSettingsSchema,
  LANGUAGE_LABELS,
  staffInviteBodySchema,
  templatesSettingsSchema,
  voiceSettingsSchema,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type AssistantToneSetting,
  type BusinessLanguage,
  type OpeningHours,
  type SettingsSection,
  type Staff,
  type StaffLink,
  type TenantSettings,
  type TenantRole,
  type WhatsappNumbers,
  whatsappNumberBodySchema,
} from '@app/shared';
import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { messageOf } from '../lib/client-api';
import { settingsApi } from './api';

const stampFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

const INDEX: { id: string; label: string }[] = [
  { id: 'business', label: 'Business' },
  { id: 'hours', label: 'Opening hours' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'escalation', label: 'Escalation' },
  { id: 'voice', label: 'Languages and voice' },
  { id: 'templates', label: 'WhatsApp templates' },
  { id: 'whatsapp', label: 'WhatsApp number' },
  { id: 'team', label: 'Team' },
];

const TONE_SAMPLES: Record<AssistantToneSetting, { label: string; sample: string }> = {
  warm: {
    label: 'Warm',
    sample: 'Yes, the Galaxy S24 is in stock. Would you like us to keep one aside for you?',
  },
  brief: { label: 'Brief', sample: 'Yes, the Galaxy S24 is in stock.' },
  formal: {
    label: 'Formal',
    sample:
      'Yes, the Galaxy S24 is available. Kindly let us know if you would like us to reserve one.',
  },
};

const ZONES = [
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Riyadh',
  'Asia/Qatar',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Asia/Muscat',
];

/** The first problem zod found, phrased for the form. */
function problem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the fields and try again.';
  const where = issue.path.filter((p) => typeof p === 'string');
  const field = where.at(-1);
  const day = where.find((p) => (WEEKDAYS as readonly string[]).includes(p));
  const prefix = day
    ? `${WEEKDAY_NAMES[day as (typeof WEEKDAYS)[number]]}: `
    : field
      ? `${field}: `
      : '';
  return `${prefix}${issue.message}.`;
}

/** One settings section: heading, its fields, a save button that says what it saves, and who changed it last. */
function Section({
  id,
  title,
  children,
  section,
  settings,
  canEdit,
  saveLabel,
  onSave,
  description,
}: {
  id: string;
  title: string;
  children: ReactNode;
  section?: SettingsSection;
  settings?: TenantSettings;
  canEdit: boolean;
  saveLabel?: string;
  onSave?: () => Promise<string | null>;
  description?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = section ? settings?.lastChanged[section] : null;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-4 border-b border-rule py-5"
    >
      <h2 id={`${id}-heading`} className="text-title font-semibold">
        {title}
      </h2>
      {description ? <p className="mt-1 max-w-prose text-graphite">{description}</p> : null}
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!onSave) return;
          setBusy(true);
          setStatus(null);
          onSave().then(
            (failed) => {
              setStatus(failed ? { ok: false, text: failed } : { ok: true, text: 'Saved.' });
              setBusy(false);
            },
            (error: unknown) => {
              setStatus({ ok: false, text: `Not saved. ${messageOf(error)}` });
              setBusy(false);
            },
          );
        }}
      >
        <fieldset disabled={!canEdit || busy} className="space-y-3">
          {children}
        </fieldset>
        {onSave && saveLabel ? (
          <div className="flex flex-wrap items-center gap-3">
            {canEdit ? (
              <button type="submit" className="button button-quiet" disabled={busy}>
                {saveLabel}
              </button>
            ) : null}
            <span className="mono text-meta text-graphite">
              {changed
                ? `Changed ${stampFormat.format(new Date(changed.at))}${changed.by ? ` · ${changed.by}` : ''}`
                : 'Not changed since the business was set up'}
            </span>
            {status ? (
              <span
                role={status.ok ? 'status' : 'alert'}
                className={status.ok ? 'text-graphite' : 'text-stamp'}
              >
                {status.text}
              </span>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block max-w-xl">
      <span className="text-label font-semibold">{label}</span>
      {hint ? <span className="block text-label text-graphite">{hint}</span> : null}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

type Save = (section: SettingsSection, schema: z.ZodType, body: unknown) => Promise<string | null>;

function BusinessSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [form, setForm] = useState(settings.business);
  return (
    <Section
      id="business"
      title="Business"
      section="business"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save business details"
      onSave={() => save('business', businessSettingsSchema, form)}
    >
      <Field label="Name">
        <input
          className="field"
          value={form.name}
          onChange={(e) => {
            setForm({ ...form, name: e.target.value });
          }}
        />
      </Field>
      <Field
        label="What you sell and where"
        hint="The assistant stays on this topic and declines anything else."
      >
        <textarea
          className="field resize-y"
          rows={3}
          dir="auto"
          value={form.summary}
          onChange={(e) => {
            setForm({ ...form, summary: e.target.value });
          }}
        />
      </Field>
      <Field label="Time zone" hint="Opening hours, budgets and analytics days follow it.">
        <input
          className="field"
          list="zones"
          value={form.timezone}
          onChange={(e) => {
            setForm({ ...form, timezone: e.target.value });
          }}
        />
        <datalist id="zones">
          {ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </Field>
    </Section>
  );
}

const DEFAULT_DAY = { open: '10:00', close: '20:00' };

function HoursSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [enabled, setEnabled] = useState(settings.hours !== null);
  const [hours, setHours] = useState<OpeningHours>(
    settings.hours ?? (Object.fromEntries(WEEKDAYS.map((d) => [d, DEFAULT_DAY])) as OpeningHours),
  );
  return (
    <Section
      id="hours"
      title={`Opening hours (${settings.business.timezone})`}
      section="hours"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save opening hours"
      description="Outside these hours, a customer handed to a person is told when the team will reply. Analytics shows after-hours waits apart."
      onSave={() => save('hours', hoursSettingsSchema, { hours: enabled ? hours : null })}
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
          }}
        />
        Set opening hours
      </label>
      {enabled ? (
        <table className="mono text-meta">
          <tbody>
            {WEEKDAYS.map((day) => {
              const span = hours[day];
              return (
                <tr key={day}>
                  <th scope="row" className="w-10 py-1 pr-2 text-left font-normal sm:w-24 sm:pr-3">
                    <span aria-hidden className="sm:hidden">
                      {WEEKDAY_NAMES[day].slice(0, 3)}
                    </span>
                    <span className="sr-only sm:not-sr-only">{WEEKDAY_NAMES[day]}</span>
                  </th>
                  <td className="py-1 pr-2 sm:pr-3">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={span !== null}
                        onChange={(e) => {
                          setHours({ ...hours, [day]: e.target.checked ? DEFAULT_DAY : null });
                        }}
                      />
                      Open
                    </label>
                  </td>
                  <td className="py-1">
                    {span ? (
                      <span className="flex items-center gap-1.5">
                        <input
                          type="time"
                          aria-label={`${WEEKDAY_NAMES[day]} opens`}
                          className="field w-auto py-1"
                          value={span.open}
                          onChange={(e) => {
                            setHours({ ...hours, [day]: { ...span, open: e.target.value } });
                          }}
                        />
                        –
                        <input
                          type="time"
                          aria-label={`${WEEKDAY_NAMES[day]} closes`}
                          className="field w-auto py-1"
                          value={span.close}
                          onChange={(e) => {
                            setHours({ ...hours, [day]: { ...span, close: e.target.value } });
                          }}
                        />
                      </span>
                    ) : (
                      <span className="text-graphite">Closed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-graphite">No hours set: the assistant never says the shop is closed.</p>
      )}
    </Section>
  );
}

function AssistantSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [form, setForm] = useState(settings.assistant);
  return (
    <Section
      id="assistant"
      title="Assistant"
      section="assistant"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save assistant settings"
      onSave={() => save('assistant', assistantSettingsSchema, form)}
    >
      <fieldset>
        <legend className="text-label font-semibold">Tone</legend>
        <div className="mt-1 space-y-2">
          {(Object.keys(TONE_SAMPLES) as AssistantToneSetting[]).map((tone) => (
            <label key={tone} className="flex items-start gap-2">
              <input
                type="radio"
                name="tone"
                className="mt-1"
                checked={form.tone === tone}
                onChange={() => {
                  setForm({ ...form, tone });
                }}
              />
              <span>
                <span className="font-semibold">{TONE_SAMPLES[tone].label}</span>
                <span className="block text-graphite">“{TONE_SAMPLES[tone].sample}”</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <Field
          label="Daily budget, tokens"
          hint="When it runs out, conversations go to a person until tomorrow."
        >
          <input
            type="number"
            min={10_000}
            step={10_000}
            className="field w-40"
            value={form.dailyTokenBudget}
            onChange={(e) => {
              setForm({ ...form, dailyTokenBudget: Number(e.target.value) });
            }}
          />
        </Field>
        <Field
          label="Replies per customer per hour"
          hint="More is treated as spam and goes to a person."
        >
          <input
            type="number"
            min={1}
            max={200}
            className="field w-24"
            value={form.turnsPerCustomerHour}
            onChange={(e) => {
              setForm({ ...form, turnsPerCustomerHour: Number(e.target.value) });
            }}
          />
        </Field>
      </div>
    </Section>
  );
}

function EscalationSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [words, setWords] = useState(settings.escalation.keywords.join(', '));
  const [limit, setLimit] = useState(settings.escalation.maxAssistantReplies);
  const [notice, setNotice] = useState(settings.escalation.outsideHoursNotice);
  return (
    <Section
      id="escalation"
      title="Escalation"
      section="escalation"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save escalation rules"
      description="The assistant already hands over when a customer asks for a person or it has no answer. These rules add your own."
      onSave={() =>
        save('escalation', escalationSettingsSchema, {
          keywords: words
            .split(/[,\n]/)
            .map((w) => w.trim())
            .filter(Boolean),
          maxAssistantReplies: limit,
          outsideHoursNotice: notice,
        })
      }
    >
      <Field
        label="Always hand to a person when a message mentions"
        hint="Words or short phrases, separated by commas, in any language: refund, शिकायत, استرداد"
      >
        <input
          className="field"
          dir="auto"
          value={words}
          onChange={(e) => {
            setWords(e.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={limit !== null}
            onChange={(e) => {
              setLimit(e.target.checked ? 6 : null);
            }}
          />
          Hand over after
        </label>
        <input
          type="number"
          min={1}
          max={50}
          aria-label="Assistant replies before handing over"
          className="field w-20"
          disabled={limit === null}
          value={limit ?? ''}
          onChange={(e) => {
            setLimit(Number(e.target.value));
          }}
        />
        <span>assistant replies in one conversation</span>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={notice}
          onChange={(e) => {
            setNotice(e.target.checked);
          }}
        />
        Outside opening hours, tell the customer when a person will reply
      </label>
    </Section>
  );
}

function VoiceSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [languages, setLanguages] = useState<BusinessLanguage[]>(settings.voice.languages);
  const [voiceReplies, setVoiceReplies] = useState(settings.voice.voiceReplies);
  return (
    <Section
      id="voice"
      title="Languages and voice"
      section="voice"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save languages and voice"
      onSave={() => save('voice', voiceSettingsSchema, { languages, voiceReplies })}
    >
      <fieldset>
        <legend className="text-label font-semibold">Languages your customers speak</legend>
        <span className="block text-label text-graphite">
          Voice notes are transcribed as one of these.
        </span>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {BUSINESS_LANGUAGES.map((language) => (
            <label key={language} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={languages.includes(language)}
                onChange={(e) => {
                  setLanguages(
                    e.target.checked
                      ? BUSINESS_LANGUAGES.filter((l) => l === language || languages.includes(l))
                      : languages.filter((l) => l !== language),
                  );
                }}
              />
              {LANGUAGE_LABELS[language]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={voiceReplies}
          onChange={(e) => {
            setVoiceReplies(e.target.checked);
          }}
        />
        <span>
          Answer voice notes with voice notes
          <span className="block text-graphite">
            Amazon Polly has no Malayalam voice, so Malayalam replies go as text.
          </span>
        </span>
      </label>
    </Section>
  );
}

function TemplatesSection({
  settings,
  canEdit,
  save,
}: {
  settings: TenantSettings;
  canEdit: boolean;
  save: Save;
}) {
  const [reopen, setReopen] = useState(settings.templates.reopen);
  const languages = settings.voice.languages;
  return (
    <Section
      id="templates"
      title="WhatsApp templates"
      section="templates"
      settings={settings}
      canEdit={canEdit}
      saveLabel="Save template names"
      description="After 24 hours without a customer message, WhatsApp only allows an approved template. Enter the name of your approved “reopen conversation” template for each language; the inbox sends the one in the customer's language, or English."
      onSave={() =>
        save('templates', templatesSettingsSchema, {
          reopen: Object.fromEntries(Object.entries(reopen).filter(([, name]) => name.trim())),
        })
      }
    >
      {languages.map((language) => (
        <Field key={language} label={`${LANGUAGE_LABELS[language]} (${language})`}>
          <input
            className="field mono"
            placeholder="reopen_conversation"
            value={reopen[language] ?? ''}
            onChange={(e) => {
              setReopen({ ...reopen, [language]: e.target.value });
            }}
          />
        </Field>
      ))}
    </Section>
  );
}

/** The business's own WhatsApp number (P-04). The token is write-only. */
function WhatsappSection({ settings }: { settings: TenantSettings }) {
  const [numbers, setNumbers] = useState<WhatsappNumbers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    phoneNumberId: '',
    wabaId: '',
    displayPhoneNumber: '',
    accessToken: '',
  });

  useEffect(() => {
    settingsApi.whatsapp().then(
      (found) => {
        setNumbers(found);
        const own = found.numbers.find((n) => n.provider === 'meta');
        if (own) {
          setForm({
            phoneNumberId: own.phoneNumberId,
            wabaId: own.wabaId ?? '',
            displayPhoneNumber: own.displayPhoneNumber,
            accessToken: '',
          });
        }
      },
      (e: unknown) => {
        setError(`Couldn't load the numbers. ${messageOf(e)}`);
      },
    );
  }, []);

  const own = numbers?.numbers.find((n) => n.provider === 'meta');
  return (
    <Section
      id="whatsapp"
      title="WhatsApp number"
      section="whatsapp"
      settings={settings}
      canEdit={numbers?.canConnect ?? false}
      saveLabel="Save WhatsApp number"
      description="Your own number, from WhatsApp Manager: its phone number ID, your WhatsApp Business Account ID and a system-user access token. The token is stored encrypted and never shown again."
      onSave={async () => {
        const body = {
          phoneNumberId: form.phoneNumberId.trim(),
          wabaId: form.wabaId.trim(),
          displayPhoneNumber: form.displayPhoneNumber,
          ...(form.accessToken.trim() ? { accessToken: form.accessToken.trim() } : {}),
        };
        const parsed = whatsappNumberBodySchema.safeParse(body);
        if (!parsed.success) return `Not saved. ${problem(parsed.error)}`;
        setNumbers(await settingsApi.connect(parsed.data));
        setForm({ ...form, accessToken: '' });
        return null;
      }}
    >
      {error ? (
        <p role="alert" className="text-stamp">
          {error}
        </p>
      ) : !numbers ? (
        <p className="mono text-meta text-graphite">Loading numbers…</p>
      ) : (
        <>
          <ul className="mono text-meta" aria-label="Numbers">
            {numbers.numbers.map((n) => (
              <li key={n.id}>
                {n.displayPhoneNumber} ·{' '}
                {n.provider === 'meta' ? 'your WhatsApp number' : 'simulator (demo)'}
                {n.provider === 'meta' ? ` · token ${n.tokenSaved ? 'saved' : 'missing'}` : ''}
              </li>
            ))}
          </ul>
          {!numbers.canConnect ? (
            <p className="text-graphite">
              {numbers.mode === 'mock'
                ? 'This desk runs in mock mode: customers write through the simulator. A real number connects in live mode.'
                : "Tokens can't be stored yet: the server has no CREDENTIALS_KEY. Ask whoever runs it."}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-4">
            <Field label="Phone number ID">
              <input
                className="field mono w-56"
                inputMode="numeric"
                value={form.phoneNumberId}
                onChange={(e) => {
                  setForm({ ...form, phoneNumberId: e.target.value });
                }}
              />
            </Field>
            <Field label="WhatsApp Business Account ID">
              <input
                className="field mono w-56"
                inputMode="numeric"
                value={form.wabaId}
                onChange={(e) => {
                  setForm({ ...form, wabaId: e.target.value });
                }}
              />
            </Field>
            <Field label="Number as customers see it">
              <input
                className="field w-56"
                value={form.displayPhoneNumber}
                onChange={(e) => {
                  setForm({ ...form, displayPhoneNumber: e.target.value });
                }}
              />
            </Field>
          </div>
          <Field
            label="Access token"
            hint={
              own?.tokenSaved
                ? 'A token is saved. Paste a new one only to replace it.'
                : 'A system-user token with whatsapp_business_messaging.'
            }
          >
            <input
              type="password"
              autoComplete="off"
              className="field mono"
              value={form.accessToken}
              onChange={(e) => {
                setForm({ ...form, accessToken: e.target.value });
              }}
            />
          </Field>
        </>
      )}
    </Section>
  );
}

function LinkBox({ link, who, kind }: { link: StaffLink; who: string; kind: 'invite' | 'reset' }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="slip max-w-xl px-3 py-2" role="status">
      <p className="mono text-meta">
        {kind === 'invite' ? 'Invite link' : 'Password reset link'} · works once · expires{' '}
        {kind === 'invite'
          ? dateFormat.format(new Date(link.expiresAt))
          : stampFormat.format(new Date(link.expiresAt))}
      </p>
      <p className="mt-1">Send this link to {who} yourself. It is shown only now.</p>
      <div className="mt-2 flex gap-2">
        <input
          readOnly
          aria-label="Link"
          className="field mono text-meta"
          value={link.url}
          onFocus={(e) => {
            e.target.select();
          }}
        />
        <button
          type="button"
          className="button button-quiet shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(link.url).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}

function TeamSection({ meId }: { meId: string }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{
    link: StaffLink;
    who: string;
    kind: 'invite' | 'reset';
  } | null>(null);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const [invite, setInvite] = useState<{ name: string; email: string; role: TenantRole }>({
    name: '',
    email: '',
    role: 'agent',
  });

  const reload = () => {
    settingsApi.staff().then(setStaff, (e: unknown) => {
      setError(`Couldn't load the team. ${messageOf(e)}`);
    });
  };
  useEffect(reload, []);

  const act = (work: Promise<unknown>) => {
    setError(null);
    work.then(reload, (e: unknown) => {
      setError(messageOf(e));
    });
  };

  return (
    <section id="team" aria-labelledby="team-heading" className="scroll-mt-4 py-5">
      <h2 id="team-heading" className="text-title font-semibold">
        Team
      </h2>
      <p className="mt-1 max-w-prose text-graphite">
        There is no email in this version: you hand people their invite or reset link yourself.
      </p>
      {error ? (
        <p role="alert" className="mt-2 border-l-4 border-stamp pl-3 text-stamp">
          {error}
        </p>
      ) : null}
      {!staff ? (
        <p className="mono mt-3 text-meta text-graphite">Loading the team…</p>
      ) : (
        <>
          <ul
            className="mt-3 max-w-3xl divide-y divide-rule border-y border-rule"
            aria-label="People in this business"
          >
            {staff.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-semibold">{m.name}</span>
                <span className="mono text-meta text-graphite">{m.email}</span>
                <span className="mono text-meta">{m.role}</span>
                <span className="ml-auto flex gap-3">
                  <button
                    type="button"
                    className="text-label font-semibold underline"
                    onClick={() => {
                      setError(null);
                      settingsApi.resetLink(m.userId).then(
                        (made) => {
                          setLink({ link: made, who: m.name, kind: 'reset' });
                        },
                        (e: unknown) => {
                          setError(messageOf(e));
                        },
                      );
                    }}
                  >
                    Make a password reset link
                  </button>
                  {m.userId !== meId ? (
                    <button
                      type="button"
                      className="text-label font-semibold text-stamp underline"
                      onClick={() => {
                        setRemoving({ userId: m.userId, name: m.name });
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
            {staff.invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-graphite"
              >
                <span>{i.name}</span>
                <span className="mono text-meta">{i.email}</span>
                <span className="mono text-meta">
                  {i.role} · invited, link expires {dateFormat.format(new Date(i.expiresAt))}
                </span>
                <button
                  type="button"
                  className="ml-auto text-label font-semibold underline"
                  onClick={() => {
                    act(settingsApi.cancelInvite(i.id));
                  }}
                >
                  Cancel invite
                </button>
              </li>
            ))}
          </ul>

          {removing ? (
            <div
              role="alertdialog"
              aria-label="Remove from the team"
              className="mt-3 flex max-w-3xl flex-wrap items-center gap-2 border-l-4 border-stamp pl-3"
            >
              <p>
                Remove {removing.name}? They are signed out at once, and conversations they hold go
                back to waiting for a person.
              </p>
              <button
                type="button"
                className="button button-quiet"
                autoFocus
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  act(settingsApi.remove(target.userId));
                }}
              >
                Remove {removing.name}
              </button>
              <button
                type="button"
                className="text-label font-semibold underline"
                onClick={() => {
                  setRemoving(null);
                }}
              >
                Keep them
              </button>
            </div>
          ) : null}

          {link ? (
            <div className="mt-3">
              <LinkBox {...link} />
            </div>
          ) : null}

          <form
            className="mt-4 flex max-w-3xl flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = staffInviteBodySchema.safeParse(invite);
              if (!parsed.success) {
                setError(problem(parsed.error));
                return;
              }
              setError(null);
              settingsApi.invite(parsed.data).then(
                (made) => {
                  setLink({ link: made, who: parsed.data.name, kind: 'invite' });
                  setInvite({ name: '', email: '', role: 'agent' });
                  reload();
                },
                (e: unknown) => {
                  setError(messageOf(e));
                },
              );
            }}
          >
            <Field label="Name">
              <input
                className="field w-48"
                value={invite.name}
                onChange={(e) => {
                  setInvite({ ...invite, name: e.target.value });
                }}
              />
            </Field>
            <Field label="Email" hint="Their sign-in name; nothing is sent to it.">
              <input
                type="email"
                className="field w-64"
                value={invite.email}
                onChange={(e) => {
                  setInvite({ ...invite, email: e.target.value });
                }}
              />
            </Field>
            <Field label="Role">
              <select
                className="field w-auto"
                value={invite.role}
                onChange={(e) => {
                  setInvite({ ...invite, role: e.target.value === 'owner' ? 'owner' : 'agent' });
                }}
              >
                <option value="agent">Agent</option>
                <option value="owner">Owner</option>
              </select>
            </Field>
            <button type="submit" className="button button-quiet">
              Make an invite link
            </button>
          </form>
        </>
      )}
    </section>
  );
}

/** Settings (DESIGN.md "Settings"): one page, a section index, each section saved on its own. */
export function Settings({ isOwner, meId }: { isOwner: boolean; meId: string }) {
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    settingsApi.read().then(setSettings, (e: unknown) => {
      setError(`Couldn't load settings. ${messageOf(e)}`);
    });
  }, []);

  const save: Save = async (section, schema, body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return `Not saved. ${problem(parsed.error)}`;
    setSettings(await settingsApi.save(section, parsed.data));
    return null;
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 px-4">
      <nav
        aria-label="Settings sections"
        className="sticky top-0 hidden h-fit w-48 shrink-0 py-5 md:block"
      >
        <p className="display text-pane">Settings</p>
        <ul className="mt-3 space-y-1">
          {INDEX.filter((s) => (s.id !== 'team' && s.id !== 'whatsapp') || isOwner).map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-list underline-offset-2 hover:underline">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1">
        <h1 className="display text-pane pt-5 md:sr-only">Settings</h1>
        {!isOwner ? (
          <p className="mt-3 border-l-4 border-rule-strong pl-3 text-graphite">
            Only the owner can change settings. You can see them here.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 border-l-4 border-stamp pl-3 text-stamp">
            {error}
          </p>
        ) : !settings ? (
          <p className="mono mt-4 text-meta text-graphite">Loading settings…</p>
        ) : (
          <div>
            <BusinessSection settings={settings} canEdit={isOwner} save={save} />
            <HoursSection settings={settings} canEdit={isOwner} save={save} />
            <AssistantSection settings={settings} canEdit={isOwner} save={save} />
            <EscalationSection settings={settings} canEdit={isOwner} save={save} />
            <VoiceSection settings={settings} canEdit={isOwner} save={save} />
            <TemplatesSection
              key={settings.voice.languages.join()}
              settings={settings}
              canEdit={isOwner}
              save={save}
            />
            {isOwner ? <WhatsappSection settings={settings} /> : null}
            {isOwner ? <TeamSection meId={meId} /> : null}
          </div>
        )}
      </main>
    </div>
  );
}
