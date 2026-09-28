namespace CyreneEmbedSidecar;

/// <summary>
/// IVF 倒排索引（k-means++ / nprobe 探测；与 TS buildIvfIndex 同构）。
/// JSON（RagStore）与 SQLite（SqliteRagStore）共用，保证检索语义一致。
/// </summary>
internal static class Ivf
{
    public sealed class Index
    {
        public double[][] Centroids = Array.Empty<double[]>();
        public List<int>[] Clusters = Array.Empty<List<int>>();
    }

    public static Index Build(List<MemoryEntry> entries, int k, int maxIter = 20)
    {
        var vectors = entries.Select((e) => e.Embedding).ToArray();
        var dim = vectors.Length > 0 ? vectors[0].Length : 0;
        if (dim == 0 || vectors.Length == 0)
        {
            return new Index { Centroids = Array.Empty<double[]>(), Clusters = Array.Empty<List<int>>() };
        }

        var effectiveK = Math.Min(k, vectors.Length);
        var clusters = new List<int>[effectiveK];
        for (var i = 0; i < effectiveK; i++) clusters[i] = new List<int>();

        var rng = new Random();
        var centroids = KmeansPlusPlusInit(vectors, effectiveK, rng);

        for (var iter = 0; iter < maxIter; iter++)
        {
            for (var i = 0; i < effectiveK; i++) clusters[i].Clear();

            for (var i = 0; i < vectors.Length; i++)
            {
                var bestIdx = 0;
                var bestSim = double.NegativeInfinity;
                for (var c = 0; c < effectiveK; c++)
                {
                    var sim = Dot(vectors[i], centroids[c]);
                    if (sim > bestSim)
                    {
                        bestSim = sim;
                        bestIdx = c;
                    }
                }
                clusters[bestIdx].Add(i);
            }

            var newCentroids = new double[effectiveK][];
            for (var c = 0; c < effectiveK; c++)
            {
                var members = clusters[c];
                if (members.Count == 0)
                {
                    newCentroids[c] = (double[])centroids[c].Clone();
                    continue;
                }
                var sum = new double[dim];
                foreach (var idx in members)
                {
                    var v = vectors[idx];
                    for (var d = 0; d < dim; d++) sum[d] += v[d];
                }
                var norm = 0.0;
                for (var d = 0; d < dim; d++) norm += sum[d] * sum[d];
                norm = Math.Sqrt(norm);
                if (norm > 0)
                {
                    for (var d = 0; d < dim; d++) sum[d] /= norm;
                }
                newCentroids[c] = sum;
            }

            var changed = false;
            for (var c = 0; c < effectiveK; c++)
            {
                if (Dot(newCentroids[c], centroids[c]) < 0.999)
                {
                    changed = true;
                    break;
                }
            }
            centroids = newCentroids;
            if (!changed) break;
        }

        return new Index { Centroids = centroids, Clusters = clusters };
    }

    private static double[][] KmeansPlusPlusInit(double[][] vectors, int k, Random rng)
    {
        var centroids = new List<double[]>(k);
        var firstIdx = rng.Next(vectors.Length);
        centroids.Add((double[])vectors[firstIdx].Clone());

        for (var c = 1; c < k; c++)
        {
            var dists = new double[vectors.Length];
            for (var i = 0; i < vectors.Length; i++)
            {
                var minDist = double.PositiveInfinity;
                foreach (var cent in centroids)
                {
                    var d = 1 - Dot(vectors[i], cent);
                    if (d < minDist) minDist = d;
                }
                dists[i] = minDist * minDist;
            }
            var total = dists.Sum();
            if (total <= 0)
            {
                while (centroids.Count < k)
                {
                    centroids.Add((double[])vectors[centroids.Count % vectors.Length].Clone());
                }
                break;
            }
            var r = rng.NextDouble() * total;
            for (var i = 0; i < dists.Length; i++)
            {
                r -= dists[i];
                if (r <= 0)
                {
                    centroids.Add((double[])vectors[i].Clone());
                    break;
                }
            }
        }
        return centroids.ToArray();
    }

    /// <summary>余弦相似度（向量已归一化，等价于点积；double 精度与 JS 一致）。</summary>
    public static double Dot(IReadOnlyList<double> a, IReadOnlyList<double> b)
    {
        var dot = 0.0;
        for (var i = 0; i < a.Count; i++) dot += a[i] * b[i];
        return dot;
    }
}
