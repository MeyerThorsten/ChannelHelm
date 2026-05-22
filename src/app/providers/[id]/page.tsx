import { ProviderForm } from '@/components/providers/ProviderForm';
import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { updateProviderFromForm } from '@/server-actions/providers';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export default async function EditProviderPage({ params }: Props) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) notFound();
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.id, numId))
    .limit(1);
  if (!provider) notFound();

  const action = updateProviderFromForm.bind(null, numId);
  // #14: never serialize the saved API key to the client. Strip it; the form
  // shows a "saved key present" placeholder and a blank submit preserves it.
  const hasApiKey = !!provider.apiKey;
  const safe = { ...provider, apiKey: '' };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/providers" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← providers
      </Link>
      <h1 className="mt-3 mb-6 text-2xl font-semibold">Edit “{provider.name}”</h1>
      <ProviderForm
        provider={safe}
        hasApiKey={hasApiKey}
        action={action}
        submitLabel="Save changes"
      />
    </main>
  );
}
