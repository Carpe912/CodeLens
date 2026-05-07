import { useEffect, useState, useCallback } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';

type CallGraphData = {
  symbol: {
    name: string;
    type: string;
    file: string;
  };
  calls: Array<{
    name: string;
    type: string;
    file: string;
  }>;
  calledBy: Array<{
    name: string;
    type: string;
    file: string;
  }>;
};

type CallGraphProps = {
  repoId: string;
  symbolName: string;
  onSymbolClick?: (symbolName: string) => void;
};

const getNodeColor = (symbolType: string): string => {
  switch (symbolType) {
    case 'function':
      return '#3b82f6'; // blue
    case 'class':
      return '#8b5cf6'; // purple
    case 'method':
      return '#10b981'; // green
    case 'arrow_function':
      return '#06b6d4'; // cyan
    default:
      return '#6b7280'; // gray
  }
};

export function CallGraph({ repoId, symbolName, onSymbolClick }: CallGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CallGraphData | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchCallGraph() {
      // 防御性检查：如果 symbolName 为空，不发送请求
      if (!symbolName || symbolName.trim() === '') {
        setError('Symbol name is required');
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          repoId,
          symbolName,
        });

        const response = await fetch(`${API_BASE}/call-graph?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch call graph: ${response.statusText}`);
        }

        const result: CallGraphData = await response.json();
        setData(result);

        // Build nodes and edges
        const newNodes: Node[] = [];
        const newEdges: Edge[] = [];

        // Center node (the symbol we're analyzing)
        newNodes.push({
          id: result.symbol.name,
          data: {
            label: (
              <div className="text-center">
                <div className="font-bold">{result.symbol.name}</div>
                <div className="text-xs text-gray-500">{result.symbol.type}</div>
                <div className="text-xs text-gray-400 truncate max-w-[200px]">
                  {result.symbol.file}
                </div>
              </div>
            ),
          },
          position: { x: 400, y: 300 },
          style: {
            background: getNodeColor(result.symbol.type),
            color: 'white',
            border: '2px solid #1f2937',
            borderRadius: '8px',
            padding: '10px',
            width: 220,
          },
        });

        // Nodes that this symbol calls (outgoing)
        result.calls.forEach((call, index) => {
          const nodeId = `out-${call.name}`;
          newNodes.push({
            id: nodeId,
            data: {
              label: (
                <div className="text-center">
                  <div className="font-semibold">{call.name}</div>
                  <div className="text-xs text-gray-500">{call.type}</div>
                  <div className="text-xs text-gray-400 truncate max-w-[180px]">
                    {call.file}
                  </div>
                </div>
              ),
            },
            position: { x: 700, y: 100 + index * 150 },
            style: {
              background: getNodeColor(call.type),
              color: 'white',
              border: '1px solid #374151',
              borderRadius: '6px',
              padding: '8px',
              width: 200,
            },
          });

          newEdges.push({
            id: `${result.symbol.name}-${nodeId}`,
            source: result.symbol.name,
            target: nodeId,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#6b7280' },
            label: 'calls',
            labelStyle: { fill: '#6b7280', fontSize: 10 },
          });
        });

        // Nodes that call this symbol (incoming)
        result.calledBy.forEach((caller, index) => {
          const nodeId = `in-${caller.name}`;
          newNodes.push({
            id: nodeId,
            data: {
              label: (
                <div className="text-center">
                  <div className="font-semibold">{caller.name}</div>
                  <div className="text-xs text-gray-500">{caller.type}</div>
                  <div className="text-xs text-gray-400 truncate max-w-[180px]">
                    {caller.file}
                  </div>
                </div>
              ),
            },
            position: { x: 100, y: 100 + index * 150 },
            style: {
              background: getNodeColor(caller.type),
              color: 'white',
              border: '1px solid #374151',
              borderRadius: '6px',
              padding: '8px',
              width: 200,
            },
          });

          newEdges.push({
            id: `${nodeId}-${result.symbol.name}`,
            source: nodeId,
            target: result.symbol.name,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#6b7280' },
            label: 'calls',
            labelStyle: { fill: '#6b7280', fontSize: 10 },
          });
        });

        setNodes(newNodes);
        setEdges(newEdges);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setError(err.message);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchCallGraph();

    return () => {
      controller.abort();
    };
  }, [repoId, symbolName, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onSymbolClick) {
        // Extract the actual symbol name from the node id
        const symbolName = node.id.replace(/^(in|out)-/, '');
        onSymbolClick(symbolName);
      }
    },
    [onSymbolClick]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading call graph...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">Error: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">No data available</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        fitView
      >
        <Background />
        <Controls />
        <Panel position="top-left" className="bg-white p-3 rounded shadow">
          <div className="text-sm">
            <div className="font-bold mb-2">Call Graph: {data.symbol.name}</div>
            <div className="text-gray-600">
              <div>Calls: {data.calls.length}</div>
              <div>Called by: {data.calledBy.length}</div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Click on nodes to explore their call graphs
            </div>
          </div>
        </Panel>
        <Panel position="top-right" className="bg-white p-2 rounded shadow text-xs">
          <div className="font-bold mb-1">Legend</div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded" style={{ background: '#3b82f6' }}></div>
            <span>Function</span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded" style={{ background: '#8b5cf6' }}></div>
            <span>Class</span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded" style={{ background: '#10b981' }}></div>
            <span>Method</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ background: '#06b6d4' }}></div>
            <span>Arrow Function</span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
