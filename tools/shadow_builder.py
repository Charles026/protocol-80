#!/usr/bin/env python3
"""
Shadow DOM Builder v2 - Project Monolith Phase 2

Reconstructs document hierarchy from Typst probe data with:
- Fragmented Geometry (Multi-Rect support for cross-page elements)
- HTML Debug Overlay visualization

Usage:
    python shadow_builder.py <typst-file>
    python shadow_builder.py src/typst/test_cli_query.typ

Output:
    1. ASCII tree in terminal
    2. shadow_debug.html file for visual verification
"""

import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ============================================================================
# Constants
# ============================================================================

# A4 page dimensions in points (for fallback)
A4_WIDTH_PT = 595.0
A4_HEIGHT_PT = 842.0

# Default rect width for visualization (probes don't capture width)
DEFAULT_RECT_WIDTH = 400.0


# ============================================================================
# Data Structures
# ============================================================================

@dataclass
class Rect:
    """
    A single rectangle on a specific page.
    Used for fragmented geometry (cross-page elements have multiple Rects).
    """
    page: int
    x: float
    y: float
    w: float = DEFAULT_RECT_WIDTH
    h: float = 20.0  # Default height for atomic probes
    
    def __str__(self) -> str:
        return f"p{self.page}({self.x:.0f},{self.y:.0f} {self.w:.0f}x{self.h:.0f})"


@dataclass 
class ShadowNode:
    """
    A node in the Shadow DOM tree with fragmented geometry support.
    
    A single logical element (e.g., a paragraph spanning 2 pages)
    can have multiple Rects - one per page fragment.
    """
    kind: str
    id: str
    seq_start: int
    children: list = field(default_factory=list)
    rects: list[Rect] = field(default_factory=list)
    payload: dict = field(default_factory=dict)
    is_atomic: bool = False
    
    # Internal tracking for split logic
    _start_page: int = 1
    _start_x: float = 0.0
    _start_y: float = 0.0
    
    def add_child(self, node: "ShadowNode") -> None:
        """Add a child node"""
        self.children.append(node)
    
    def set_start(self, location: dict) -> None:
        """Record start position for later split calculation"""
        self._start_page = location.get("page", 1)
        self._start_x = location.get("x", 0)
        self._start_y = location.get("y", 0)
    
    def close(self, end_location: dict) -> None:
        """
        Close node and calculate geometry using Split Logic.
        
        Scenario A (Same Page): Create 1 Rect
        Scenario B (Cross Page): Create 2 Rects (start fragment + end fragment)
        """
        end_page = end_location.get("page", 1)
        end_x = end_location.get("x", 0)
        end_y = end_location.get("y", 0)
        
        if self._start_page == end_page:
            # === SCENARIO A: Same Page ===
            h = max(end_y - self._start_y, 15)  # Minimum height
            self.rects.append(Rect(
                page=self._start_page,
                x=self._start_x,
                y=self._start_y,
                w=DEFAULT_RECT_WIDTH,
                h=h
            ))
        else:
            # === SCENARIO B: Cross Page ===
            # Rect 1: Start page - from start_y to bottom
            h1 = A4_HEIGHT_PT - self._start_y - 50  # Leave margin
            self.rects.append(Rect(
                page=self._start_page,
                x=self._start_x,
                y=self._start_y,
                w=DEFAULT_RECT_WIDTH,
                h=max(h1, 50)
            ))
            
            # Rect 2: End page - from top to end_y
            self.rects.append(Rect(
                page=end_page,
                x=end_x,
                y=50,  # Top margin
                w=DEFAULT_RECT_WIDTH,
                h=max(end_y - 50, 50)
            ))
    
    def add_atomic_rect(self, location: dict) -> None:
        """Add a single rect for atomic (non-paired) probes"""
        self.rects.append(Rect(
            page=location.get("page", 1),
            x=location.get("x", 0),
            y=location.get("y", 0),
            w=10,  # Small marker
            h=10
        ))
    
    def get_summary(self) -> str:
        """Get brief summary for ASCII tree"""
        if not self.rects:
            return ""
        if len(self.rects) == 1:
            r = self.rects[0]
            return f"(p{r.page}, y:{r.y:.0f}-{r.y + r.h:.0f})"
        else:
            pages = sorted(set(r.page for r in self.rects))
            return f"(p{pages[0]}-p{pages[-1]}, {len(self.rects)} frags)"
    
    def to_tree_string(self, prefix: str = "", is_last: bool = True) -> str:
        """Generate ASCII tree representation"""
        connector = "└── " if is_last else "├── "
        child_prefix = prefix + ("    " if is_last else "│   ")
        
        # Format node info
        summary = self.get_summary()
        payload_info = ""
        if self.payload:
            ptype = self.payload.get("type") or self.payload.get("kind", "")
            if ptype and ptype != self.kind:
                payload_info = f" [{ptype}]"
        
        line = f"{prefix}{connector}[{self.kind}:{self.id}]{payload_info} {summary}\n"
        
        for i, child in enumerate(self.children):
            is_child_last = (i == len(self.children) - 1)
            line += child.to_tree_string(child_prefix, is_child_last)
        
        return line


# ============================================================================
# Core Algorithm
# ============================================================================

def run_typst_query(filepath: str) -> list[dict]:
    """Execute typst query and return sorted probes"""
    cmd = ["typst", "query", filepath, "<monolith-probe>", "--field", "value"]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        probes = json.loads(result.stdout)
        return sorted(probes, key=lambda p: p.get("_seq", 0))
    except subprocess.CalledProcessError as e:
        print(f"Error: {e.stderr}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"JSON Error: {e}", file=sys.stderr)
        sys.exit(1)


def build_shadow_dom(probes: list[dict]) -> ShadowNode:
    """Build tree with fragmented geometry support"""
    root = ShadowNode(kind="DOCUMENT", id="ROOT", seq_start=0)
    stack: list[ShadowNode] = [root]
    pages_seen = set()
    
    for probe in probes:
        probe_id = probe.get("id", "unknown")
        payload = probe.get("payload", {})
        location = probe.get("location", {})
        seq = probe.get("_seq", 0)
        kind = payload.get("kind", probe.get("kind", "marker"))
        edge = payload.get("edge")
        
        if "page" in location:
            pages_seen.add(location["page"])
        
        current_parent = stack[-1]
        
        if edge == "start":
            node = ShadowNode(
                kind=kind,
                id=probe_id.replace("-start", ""),
                seq_start=seq,
                payload=payload
            )
            node.set_start(location)
            current_parent.add_child(node)
            stack.append(node)
            
        elif edge == "end":
            if len(stack) > 1:
                closed_node = stack.pop()
                closed_node.close(location)
            
        else:
            # Atomic node
            node = ShadowNode(
                kind=kind,
                id=probe_id,
                seq_start=seq,
                payload=payload,
                is_atomic=True
            )
            node.add_atomic_rect(location)
            current_parent.add_child(node)
    
    root.payload["pages"] = len(pages_seen)
    return root


# ============================================================================
# HTML Visualization Generator
# ============================================================================

def collect_all_rects(node: ShadowNode, results: list[tuple[str, str, Rect]]) -> None:
    """Recursively collect all rects with their node info"""
    for rect in node.rects:
        results.append((node.kind, node.id, rect))
    for child in node.children:
        collect_all_rects(child, results)


def export_html(root: ShadowNode, filename: str = "shadow_debug.html") -> str:
    """Generate HTML visualization file"""
    pages = root.payload.get("pages", 1)
    all_rects: list[tuple[str, str, Rect]] = []
    collect_all_rects(root, all_rects)
    
    # Group rects by page
    rects_by_page: dict[int, list[tuple[str, str, Rect]]] = {}
    for kind, node_id, rect in all_rects:
        if rect.page not in rects_by_page:
            rects_by_page[rect.page] = []
        rects_by_page[rect.page].append((kind, node_id, rect))
    
    # Generate HTML
    html_parts = ['''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Shadow DOM Debug Overlay</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e;
            color: #eee;
            padding: 20px;
        }
        h1 { color: #00d4ff; }
        .page-container {
            display: inline-block;
            margin: 20px;
            vertical-align: top;
        }
        .page-label {
            text-align: center;
            margin-bottom: 10px;
            font-weight: bold;
        }
        .page {
            width: 595px;
            height: 842px;
            background: white;
            position: relative;
            border: 2px solid #333;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        .rect {
            position: absolute;
            border: 2px solid rgba(255, 50, 50, 0.8);
            background: rgba(255, 50, 50, 0.15);
            cursor: pointer;
            transition: all 0.2s;
            box-sizing: border-box;
        }
        .rect:hover {
            background: rgba(255, 50, 50, 0.4);
            border-color: #ff0000;
            z-index: 100;
        }
        .rect .tooltip {
            display: none;
            position: absolute;
            top: -30px;
            left: 0;
            background: #222;
            color: #fff;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            white-space: nowrap;
            z-index: 1000;
        }
        .rect:hover .tooltip {
            display: block;
        }
        .legend {
            margin-bottom: 20px;
            padding: 15px;
            background: #16213e;
            border-radius: 8px;
        }
    </style>
</head>
<body>
    <h1>🔍 Shadow DOM Debug Overlay</h1>
    <div class="legend">
        <strong>Legend:</strong> Red boxes = Probe regions | Hover for details | 
        Total: ''' + str(len(all_rects)) + ''' rects across ''' + str(pages) + ''' pages
    </div>
''']
    
    # Generate page containers
    for page_num in sorted(rects_by_page.keys()):
        html_parts.append(f'''
    <div class="page-container">
        <div class="page-label">Page {page_num}</div>
        <div class="page">''')
        
        for kind, node_id, rect in rects_by_page[page_num]:
            # Scale from pt to px (1:1 for now)
            left = rect.x
            top = rect.y
            width = rect.w
            height = rect.h
            
            html_parts.append(f'''
            <div class="rect" style="left:{left:.1f}px; top:{top:.1f}px; width:{width:.1f}px; height:{height:.1f}px;">
                <span class="tooltip">[{kind}] {node_id}</span>
            </div>''')
        
        html_parts.append('''
        </div>
    </div>''')
    
    html_parts.append('''
</body>
</html>''')
    
    html_content = "".join(html_parts)
    
    # Write file
    output_path = Path(filename)
    output_path.write_text(html_content)
    
    return str(output_path.absolute())


def print_tree(root: ShadowNode) -> None:
    """Print ASCII tree"""
    pages = root.payload.get("pages", 1)
    print(f"[DOCUMENT-ROOT] (Pages: {pages})")
    for i, child in enumerate(root.children):
        is_last = (i == len(root.children) - 1)
        print(child.to_tree_string("", is_last), end="")


# ============================================================================
# Main
# ============================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: python shadow_builder.py <typst-file>")
        sys.exit(1)
    
    filepath = sys.argv[1]
    
    print(f"🔍 Querying probes from: {filepath}")
    probes = run_typst_query(filepath)
    print(f"📊 Found {len(probes)} probes")
    print()
    
    print("🌳 Building Shadow DOM with Fragmented Geometry...")
    root = build_shadow_dom(probes)
    print()
    
    print("=" * 60)
    print_tree(root)
    print("=" * 60)
    print()
    
    print("🎨 Generating HTML visualization...")
    html_path = export_html(root, "shadow_debug.html")
    print(f"✅ Created: {html_path}")
    print()
    print("Open in browser to verify visual alignment!")


if __name__ == "__main__":
    main()
