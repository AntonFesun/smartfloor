import { GuestScreen } from "@/components/guest/guest-screen";

export default async function GuestPage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  return <GuestScreen tableId={tableId.toUpperCase()} />;
}
