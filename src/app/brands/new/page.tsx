import { BrandForm } from '@/components/BrandForm';
import { createBrandFromForm } from '@/server-actions/brands';
import Link from 'next/link';

export default function NewBrandPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/brands" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← brands
      </Link>
      <h1 className="mt-3 mb-6 text-2xl font-semibold">New brand</h1>
      <BrandForm action={createBrandFromForm} submitLabel="Create brand" />
    </main>
  );
}
