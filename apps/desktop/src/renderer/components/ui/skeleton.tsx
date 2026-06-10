// Loading placeholder block. Compose several to mimic the shape of pending content
// (e.g. a card row) so the layout doesn't jump when real data arrives.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-gray-200/80 ${className}`} />;
}

// A card-shaped skeleton matching the project/material card footprint.
export function CardSkeleton() {
  return (
    <div aria-hidden className="bg-white border border-gray-100 rounded-2xl p-5">
      <Skeleton className="h-2 w-16 mb-4" />
      <Skeleton className="h-4 w-3/4 mb-2" />
      <Skeleton className="h-3 w-1/2 mb-4" />
      <Skeleton className="h-2 w-20" />
    </div>
  );
}
