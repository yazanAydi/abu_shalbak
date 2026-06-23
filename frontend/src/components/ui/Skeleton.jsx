export function Skeleton({ width = "100%", height = 16, radius, style }) {
  return (
    <span
      className="ui-skel"
      style={{ display: "block", width, height, borderRadius: radius, ...style }}
    />
  );
}

export function SkeletonRows({ rows = 5, cols = 4 }) {
  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: "flex", gap: "0.75rem" }}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} height={14} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
