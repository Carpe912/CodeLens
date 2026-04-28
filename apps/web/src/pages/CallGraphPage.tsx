import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CallGraph } from '../components/CallGraph';

export function CallGraphPage() {
  const navigate = useNavigate();
  const { id, symbolName } = useParams<{ id: string; symbolName: string }>();
  const repoId = id || '';
  const decodedSymbolName = symbolName ? decodeURIComponent(symbolName) : '';

  const handleSymbolClick = useCallback((newSymbolName: string) => {
    navigate(`/repo/${repoId}/call-graph/${encodeURIComponent(newSymbolName)}`);
  }, [navigate, repoId]);

  return (
    <div className="h-screen flex flex-col">
      <div className="p-4 border-b bg-white">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(`/repo/${repoId}`)} className="text-blue-600 hover:underline">
              ← 返回搜索
            </button>
            <div className="text-lg font-semibold">
              调用图: {decodedSymbolName}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1">
        <CallGraph
          repoId={repoId}
          symbolName={decodedSymbolName}
          onSymbolClick={handleSymbolClick}
        />
      </div>
    </div>
  );
}
