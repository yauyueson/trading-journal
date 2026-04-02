import React, { useMemo } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  gradientFrom?: string;
  gradientTo?: string;
  strokeWidth?: number;
  className?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = 120,
  height = 40,
  color = '#4EBE96',
  gradientFrom,
  gradientTo,
  strokeWidth = 1.5,
  className = '',
}) => {
  const { path, areaPath } = useMemo(() => {
    if (data.length < 2) return { path: '', areaPath: '' };

    const pad = 2;
    const mn = Math.min(...data);
    const mx = Math.max(...data);
    const range = mx - mn || 1;

    const points = data.map((v, i) => ({
      x: pad + (i / (data.length - 1)) * (width - 2 * pad),
      y: pad + (1 - (v - mn) / range) * (height - 2 * pad),
    }));

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const area = `${linePath} L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;

    return { path: linePath, areaPath: area };
  }, [data, width, height]);

  if (data.length < 2) return null;

  const gFrom = gradientFrom || color;
  const gTo = gradientTo || color;
  const id = `spark-${color.replace('#', '')}`;

  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={gFrom} stopOpacity={0.25} />
          <stop offset="100%" stopColor={gTo} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${id}-fill)`} />
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
