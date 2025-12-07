/**
 * ProseMirror to Typst Serializer
 * 
 * Converts ProseMirror document structure to Typst markup with probe injections.
 * This is the bridge between the editor state and the Typst compiler.
 */

import type { Node } from 'prosemirror-model'

/**
 * Configuration for the serializer
 */
export interface SerializerConfig {
    /** Whether to inject probes around semantic nodes */
    injectProbes: boolean
    /** The probe library import path */
    probeLibPath: string
}

const DEFAULT_CONFIG: SerializerConfig = {
    injectProbes: true,
    probeLibPath: '/lib/probe.typ',
}

/**
 * Generate a unique ID for a node based on its position and type
 */
function generateNodeId(nodeType: string, index: number): string {
    return `${nodeType}-${index}`
}

/**
 * Escape special Typst characters in text content
 */
function escapeTypst(text: string): string {
    // Escape characters that have special meaning in Typst
    return text
        .replace(/\\/g, '\\\\')
        .replace(/#/g, '\\#')
        .replace(/\$/g, '\\$')
        .replace(/@/g, '\\@')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
}

/**
 * Generate probe injection code for node start
 */
function probeStart(id: string, kind: string): string {
    return `#probe("${id}-start", payload: (kind: "${kind}", edge: "start"))\n`
}

/**
 * Generate probe injection code for node end
 */
function probeEnd(id: string, kind: string): string {
    return `\n#probe("${id}-end", payload: (kind: "${kind}", edge: "end"))`
}

/**
 * Serialize a ProseMirror document node to Typst markup
 */
export function serializeToTypst(
    doc: Node,
    config: Partial<SerializerConfig> = {}
): string {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const parts: string[] = []

    // Generate preamble with probe library import
    parts.push(`// Monolith Editor - Generated Typst Document`)
    parts.push(`// Auto-generated with probe instrumentation`)
    parts.push(``)

    if (cfg.injectProbes) {
        parts.push(`#import "${cfg.probeLibPath}": *`)
        parts.push(``)
    }

    // Counters for generating unique IDs
    const counters: Record<string, number> = {}

    /**
     * Get next ID for a node type
     */
    function nextId(type: string): string {
        counters[type] = (counters[type] || 0) + 1
        return generateNodeId(type, counters[type])
    }

    /**
     * Serialize a single node
     */
    function serializeNode(node: Node): string {
        switch (node.type.name) {
            case 'doc':
                // Document root - serialize all children
                const children: string[] = []
                node.forEach((child) => {
                    children.push(serializeNode(child))
                })
                return children.join('\n\n')

            case 'paragraph': {
                const id = nextId('para')
                const textContent = serializeInlineContent(node)

                if (cfg.injectProbes && textContent.trim()) {
                    return probeStart(id, 'paragraph') + textContent + probeEnd(id, 'paragraph')
                }
                return textContent
            }

            case 'heading': {
                const level = node.attrs.level || 1
                const id = nextId(`h${level}`)
                const prefix = '='.repeat(level) + ' '
                const textContent = serializeInlineContent(node)

                if (cfg.injectProbes) {
                    return probeStart(id, `heading-${level}`) + prefix + textContent + probeEnd(id, `heading-${level}`)
                }
                return prefix + textContent
            }

            case 'code_block': {
                const id = nextId('code')
                const text = node.textContent

                if (cfg.injectProbes) {
                    return probeStart(id, 'code') + '```\n' + text + '\n```' + probeEnd(id, 'code')
                }
                return '```\n' + text + '\n```'
            }

            case 'blockquote': {
                const id = nextId('quote')
                const children: string[] = []
                node.forEach((child) => {
                    children.push('> ' + serializeNode(child).split('\n').join('\n> '))
                })
                const content = children.join('\n')

                if (cfg.injectProbes) {
                    return probeStart(id, 'blockquote') + content + probeEnd(id, 'blockquote')
                }
                return content
            }

            case 'bullet_list': {
                const id = nextId('list')
                const items: string[] = []
                node.forEach((item) => {
                    items.push('- ' + serializeNode(item))
                })
                const content = items.join('\n')

                if (cfg.injectProbes) {
                    return probeStart(id, 'bullet-list') + content + probeEnd(id, 'bullet-list')
                }
                return content
            }

            case 'ordered_list': {
                const id = nextId('list')
                const items: string[] = []
                let num = 1
                node.forEach((item) => {
                    items.push(`${num}. ` + serializeNode(item))
                    num++
                })
                const content = items.join('\n')

                if (cfg.injectProbes) {
                    return probeStart(id, 'ordered-list') + content + probeEnd(id, 'ordered-list')
                }
                return content
            }

            case 'list_item': {
                const children: string[] = []
                node.forEach((child) => {
                    children.push(serializeNode(child))
                })
                return children.join('\n')
            }

            case 'horizontal_rule':
                return '#line(length: 100%)'

            case 'text':
                return serializeTextNode(node)

            default:
                // Fallback: just get text content
                console.warn(`Unknown node type: ${node.type.name}`)
                return node.textContent
        }
    }

    /**
     * Serialize inline content (text, marks, etc.)
     */
    function serializeInlineContent(node: Node): string {
        const parts: string[] = []
        node.forEach((child) => {
            parts.push(serializeTextNode(child))
        })
        return parts.join('')
    }

    /**
     * Serialize a text node with its marks
     */
    function serializeTextNode(node: Node): string {
        if (node.type.name !== 'text') {
            return node.textContent
        }

        let text = node.text || ''

        // Don't escape content that looks like math ($...$)
        if (!text.startsWith('$') && !text.endsWith('$')) {
            text = escapeTypst(text)
        }

        // Apply marks
        for (const mark of node.marks) {
            switch (mark.type.name) {
                case 'bold':
                case 'strong':
                    text = `*${text}*`
                    break
                case 'italic':
                case 'em':
                    text = `_${text}_`
                    break
                case 'code':
                    text = '`' + text + '`'
                    break
                case 'link':
                    text = `#link("${mark.attrs.href}")[${text}]`
                    break
            }
        }

        return text
    }

    // Serialize the document
    parts.push(serializeNode(doc))

    return parts.join('\n')
}

/**
 * Simple serialization for plain text (no ProseMirror doc structure)
 * Used when we don't have a full ProseMirror document
 */
export function serializePlainText(
    text: string,
    config: Partial<SerializerConfig> = {}
): string {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const parts: string[] = []

    // Preamble
    parts.push(`// Monolith Editor - Generated Typst Document`)
    parts.push(``)

    if (cfg.injectProbes) {
        parts.push(`#import "${cfg.probeLibPath}": *`)
        parts.push(``)
    }

    // Split text into paragraphs
    const paragraphs = text.split(/\n\n+/)

    paragraphs.forEach((para, index) => {
        const trimmed = para.trim()
        if (!trimmed) return

        const id = `para-${index + 1}`

        // Don't escape math content
        const content = trimmed.includes('$') ? trimmed : escapeTypst(trimmed)

        if (cfg.injectProbes) {
            parts.push(probeStart(id, 'paragraph') + content + probeEnd(id, 'paragraph'))
        } else {
            parts.push(content)
        }
    })

    return parts.join('\n\n')
}
