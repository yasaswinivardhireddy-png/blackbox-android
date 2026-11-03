// Minimal Prometheus text-format metrics.
type Labels = Record<string, string>;

const fmt = (labels: Labels) => {
  const keys = Object.keys(labels);
  return keys.length === 0 ? '' : `{${keys.map((k) => `${k}="${labels[k]!.replace(/["\\\n]/g, '_')}"`).join(',')}}`;
};

export class Counter {
  private series = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = JSON.stringify(labels);
    const s = this.series.get(key);
    if (s) s.value += by;
    else this.series.set(key, { labels, value: by });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.series.values()) lines.push(`${this.name}${fmt(s.labels)} ${s.value}`);
    return lines.join('\n');
  }
}

export class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }

  observe(labels: Labels, value: number): void {
    const key = JSON.stringify(labels);
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((b, i) => value <= b && s!.counts[i]!++);
    s.sum += value;
    s.count++;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${fmt(s.labels)} ${s.sum}`, `${this.name}_count${fmt(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private metrics: (Counter | Histogram)[] = [];
  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.metrics.push(h);
    return h;
  }
  render(): string {
    return `${this.metrics.map((m) => m.render()).join('\n')}\n`;
  }
}
