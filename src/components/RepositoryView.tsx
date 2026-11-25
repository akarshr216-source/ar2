import { useEffect, useState } from 'react';
import { FileCode } from 'lucide-react';

interface RepositoryViewProps {
  apiBaseUrl?: string;
}

export function RepositoryView({ apiBaseUrl = '' }: RepositoryViewProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('server/cmd/netfusion-server/main.go');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const normalizedBase = apiBaseUrl.replace(/\/+$/, '');

  useEffect(() => {
    const loadFiles = async () => {
      try {
        const res = await fetch(`${normalizedBase}/api/repo/files`);
        if (res.ok) {
          const data = (await res.json()) as { files: string[] };
          setFiles(data.files);
          if (data.files.length > 0 && !data.files.includes(selectedFile)) {
            setSelectedFile(data.files[0]);
          }
        }
      } finally {
        setLoading(false);
      }
    };
    void loadFiles();
  }, [normalizedBase, selectedFile]);

  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    const loadContent = async () => {
      const res = await fetch(
        `${normalizedBase}/api/repo/file?path=${encodeURIComponent(selectedFile)}`
      );
      if (res.ok && active) {
        const data = (await res.json()) as { content: string };
        setContent(data.content);
      }
    };
    void loadContent();
    return () => {
      active = false;
    };
  }, [normalizedBase, selectedFile]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <section className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 px-2 py-1">
          NetFusion v0.1 Repository Files
        </h2>
        {loading ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 px-2">Loading file index...</p>
        ) : (
          <div className="space-y-0.5 max-h-[540px] overflow-y-auto">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setSelectedFile(f)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs font-mono rounded-lg text-left transition-colors ${
                  selectedFile === f
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <FileCode className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{f}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <span className="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100">
            {selectedFile}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">Read-only source</span>
        </div>
        <pre className="p-4 text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-200 overflow-x-auto max-h-[540px]">
          {content}
        </pre>
      </section>
    </div>
  );
}
