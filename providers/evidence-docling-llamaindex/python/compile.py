from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

os.environ.setdefault("TORCH_COMPILE_DISABLE", "1")
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

from llama_index.core import Document, Settings, SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter
from llama_index.readers.database import DatabaseReader
from sqlalchemy import create_engine, inspect


REQUEST = Path(os.environ.get("DKB_COMPILER_REQUEST", "/request/request.json"))
OUTPUT = Path(os.environ.get("DKB_COMPILER_OUTPUT", "/output/llamaindex-compiled.json"))
INPUT_ROOT = Path(os.environ.get("DKB_COMPILER_INPUT", "/input"))
MODEL = os.environ.get("DKB_COMPILER_MODEL", "BAAI/bge-small-en-v1.5")
ASYNC_WORKERS = max(1, min(4, int(os.environ.get("DKB_LLAMA_ASYNC_WORKERS", "1"))))
DOCUMENT_BATCH_SIZE = max(1, min(256, int(os.environ.get("DKB_LLAMA_DOCUMENT_BATCH_SIZE", "32"))))
DOCLING_ENABLED = os.environ.get("DKB_DOCLING_RICH_FILES", "1").lower() not in {"0", "false", "no", "off"}
DOCLING_FALLBACK = os.environ.get("DKB_DOCLING_FALLBACK", "1").lower() not in {"0", "false", "no", "off"}
DEFAULT_DOCLING_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm"}
EXCLUDED_FILES = {"dkb.json", "dkb-lock.json", "dkb-profile.lock.json", "dkb-release.json", ".dkb-package.json"}

_DOCLING_CONVERTER: Any | None = None
_DOCLING_CHUNKER: Any | None = None
_COMPILER_TIMINGS: dict[str, float] = {
    "doclingTokenizer": 0.0,
    "doclingConversion": 0.0,
    "doclingChunk": 0.0,
}
_DOCLING_FILES = 0
_DOCLING_FALLBACKS = 0


def emit_event(event: str, **values: Any) -> None:
    print(json.dumps({"event": event, **values}, sort_keys=True, separators=(",", ":")), flush=True)


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest_text(value: str) -> str:
    return digest_bytes(value.encode("utf-8"))


def relative_path(value: Path) -> str:
    return value.absolute().relative_to(INPUT_ROOT.absolute()).as_posix()


def resolved_input_path(value: str) -> Path:
    input_root = INPUT_ROOT.resolve()
    candidate = (input_root / value.replace("\\", "/")).resolve()
    try:
        candidate.relative_to(input_root)
    except ValueError as exc:
        raise RuntimeError(f"source path resolves outside compiler input root: {value}") from exc
    return candidate


def quoted_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def docling_extensions() -> set[str]:
    configured = os.environ.get("DKB_DOCLING_EXTENSIONS")
    if not configured:
        return DEFAULT_DOCLING_EXTENSIONS

    return {
        item.strip().lower() if item.strip().startswith(".") else f".{item.strip().lower()}"
        for item in configured.split(",")
        if item.strip()
    }


def is_docling_rich_file(path_value: Path) -> bool:
    return DOCLING_ENABLED and path_value.suffix.lower() in docling_extensions()


def source_files_for_store(root: Path, include: list[Any] | None, exclude: list[Any] | None) -> list[Path]:
    excluded = {
        resolved_input_path(str(item))
        for item in (exclude or [])
    }

    if include:
        return sorted(
            path
            for path in (resolved_input_path(str(item)) for item in include)
            if path not in excluded
        )

    files: list[Path] = []
    for candidate in root.rglob("*"):
        if not candidate.is_file():
            continue
        if candidate.is_symlink():
            raise RuntimeError(f"symbolic links are not allowed in compiler input: {candidate}")
        if candidate in excluded:
            continue
        relative_parts = candidate.relative_to(root).parts
        if any(part.startswith(".") for part in relative_parts):
            continue
        if candidate.name in EXCLUDED_FILES:
            continue
        files.append(candidate)

    return sorted(files)


def source_metadata(
    request: dict[str, Any],
    store_id: str,
    source_id: str,
    source_type: str,
    target: Path,
    contents: bytes | None = None,
) -> dict[str, Any]:
    return {
        "dkb_package_id": request["dkbId"],
        "dkb_package_version": request["version"],
        "dkb_source_id": source_id,
        "dkb_store_id": store_id,
        "dkb_source_type": source_type,
        "dkb_path": relative_path(target),
        "dkb_source_hash": digest_bytes(contents if contents is not None else target.read_bytes()),
    }


def file_documents(request: dict[str, Any], store: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    root = resolved_input_path(str(store["path"]))
    include = store.get("includePaths")
    exclude = store.get("excludePaths")
    if not root.exists():
        raise RuntimeError(f"filesystem store path does not exist: {store['path']}")

    input_files = source_files_for_store(root, include, exclude)
    emit_event("dkb.compiler.sources.discovered", files=len(input_files), storeId=store["id"])
    fallback_reasons: dict[str, str] = {}
    rich_chunks: list[dict[str, Any]] = []
    fallback_files: list[Path] = []
    normal_files: list[Path] = []

    for target in input_files:
        if is_docling_rich_file(target):
            try:
                rich_chunks.extend(docling_chunks_for_file(request, store["id"], target))
            except Exception as exc:
                if not DOCLING_FALLBACK:
                    raise RuntimeError(f"Docling failed for {relative_path(target)}: {exc}") from exc
                fallback_reasons[relative_path(target)] = str(exc)
                fallback_files.append(target)
        else:
            normal_files.append(target)

    normal_files.extend(fallback_files)

    def metadata(path_value: str, contents: bytes | None = None) -> dict[str, Any]:
        target = Path(path_value)
        values = source_metadata(request, store["id"], f"file:{relative_path(target)}", "filesystem", target, contents)
        reason = fallback_reasons.get(values["dkb_path"])
        if reason:
            values["dkb_rich_parser"] = "llamaindex-fallback"
            values["dkb_rich_parser_fallback_reason"] = reason
        return values

    reader_options = {
        "file_metadata": metadata,
        "filename_as_id": True,
        "raise_on_error": True,
    }
    docs: list[Any] = []
    reader_files: list[Path] = []
    for target in normal_files:
        try:
            contents = target.read_bytes()
            if b"\x00" in contents:
                reader_files.append(target)
                continue
            text = contents.decode("utf-8")
        except UnicodeDecodeError:
            reader_files.append(target)
            continue

        values = metadata(str(target), contents)
        docs.append(Document(
            text=text,
            metadata=values,
            id_=f"{request['dkbId']}:{request['version']}:{values['dkb_source_id']}",
        ))

    if reader_files:
        reader = SimpleDirectoryReader(input_files=[str(item) for item in reader_files], **reader_options)
        reader_documents = reader.load_data()
        for doc in reader_documents:
            doc.id_ = f"{request['dkbId']}:{request['version']}:{doc.metadata['dkb_source_id']}"
        docs.extend(reader_documents)
    emit_event(
        "dkb.compiler.sources.loaded",
        directTextFiles=len(normal_files) - len(reader_files),
        documents=len(docs),
        durationMs=round((time.perf_counter() - started) * 1000, 3),
        fallbackReaderFiles=len(reader_files),
        richFiles=len(rich_chunks_by_source(rich_chunks)),
        storeId=store["id"],
    )
    return {
        "documents": docs,
        "richChunks": rich_chunks,
        "doclingFiles": len(rich_chunks_by_source(rich_chunks)),
        "doclingFallbacks": len(fallback_files),
    }


def rich_chunks_by_source(chunks: list[dict[str, Any]]) -> set[str]:
    return {
        str(chunk["metadata"].get("dkb_path"))
        for chunk in chunks
        if isinstance(chunk.get("metadata"), dict) and chunk["metadata"].get("dkb_path")
    }


def docling_chunks_for_file(request: dict[str, Any], store_id: str, target: Path) -> list[dict[str, Any]]:
    global _DOCLING_FILES
    converter, chunker = docling_tools()
    source_hash = digest_bytes(target.read_bytes())
    conversion_started = time.perf_counter()
    result = converter.convert(target)
    conversion_done = time.perf_counter()
    chunks: list[dict[str, Any]] = []
    for ordinal, chunk in enumerate(chunker.chunk(dl_doc=result.document)):
        dump = chunk.model_dump(mode="json") if hasattr(chunk, "model_dump") else {}
        text = chunker.contextualize(chunk)
        chunks.append(docling_chunk_record_base(request, store_id, target, source_hash, ordinal, text, dump))
    chunk_done = time.perf_counter()
    _COMPILER_TIMINGS["doclingConversion"] += (conversion_done - conversion_started) * 1000
    _COMPILER_TIMINGS["doclingChunk"] += (chunk_done - conversion_done) * 1000
    _DOCLING_FILES += 1
    return chunks


def docling_tools() -> tuple[Any, Any]:
    global _DOCLING_CONVERTER, _DOCLING_CHUNKER
    if _DOCLING_CONVERTER is not None and _DOCLING_CHUNKER is not None:
        return _DOCLING_CONVERTER, _DOCLING_CHUNKER

    started = time.perf_counter()
    from docling.document_converter import DocumentConverter
    from docling.chunking import HybridChunker
    from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    _DOCLING_CONVERTER = DocumentConverter()
    _DOCLING_CHUNKER = HybridChunker(
        tokenizer=HuggingFaceTokenizer(tokenizer=tokenizer, max_tokens=512),
        repeat_table_header=True,
        merge_peers=True,
    )
    _COMPILER_TIMINGS["doclingTokenizer"] += (time.perf_counter() - started) * 1000
    return _DOCLING_CONVERTER, _DOCLING_CHUNKER


def docling_chunk_record_base(
    request: dict[str, Any],
    store_id: str,
    target: Path,
    source_hash: str,
    ordinal: int,
    text: str,
    dump: dict[str, Any],
) -> dict[str, Any]:
    relative = relative_path(target)
    meta = dump.get("meta") if isinstance(dump.get("meta"), dict) else {}
    headings = string_list(meta.get("headings"))
    captions = string_list(meta.get("captions"))
    doc_items = meta.get("doc_items", []) if isinstance(meta.get("doc_items"), list) else []
    item_refs: list[str] = []
    pages: list[int] = []
    labels: list[str] = []
    table_refs: list[str] = []
    for item in doc_items:
        if not isinstance(item, dict):
            continue
        ref = item.get("self_ref") or item.get("ref") or item.get("cref")
        if isinstance(ref, str):
            item_refs.append(ref)
            if "/tables/" in ref:
                table_refs.append(ref)
        label = item.get("label")
        if isinstance(label, str):
            labels.append(label)
        for prov in item.get("prov", []) if isinstance(item.get("prov"), list) else []:
            if isinstance(prov, dict) and isinstance(prov.get("page_no"), int):
                pages.append(prov["page_no"])

    locator: dict[str, Any] = {"path": relative}
    if pages:
        locator["pages"] = sorted(set(pages))
    if item_refs:
        locator["itemRefs"] = item_refs
    if table_refs:
        locator["tableRefs"] = table_refs
    if headings:
        locator["headings"] = headings
    if captions:
        locator["captions"] = captions
    if labels:
        locator["doclingLabels"] = sorted(set(labels))

    metadata = source_metadata(request, store_id, f"file:{relative}", "filesystem", target)
    metadata.update({
        "dkb_rich_parser": "docling",
        "dkb_docling": {
            "headings": headings,
            "captions": captions,
            "itemRefs": item_refs,
            "tableRefs": table_refs,
            "pages": sorted(set(pages)),
            "labels": sorted(set(labels)),
        },
    })

    return {
        "storeId": store_id,
        "type": "filesystem",
        "locator": locator,
        "assetLocator": {
            "path": relative,
            "sourceHash": source_hash,
        },
        "title": target.name,
        "text": text,
        "hash": digest_text(text),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "chunkOrdinal": ordinal,
        "chunkStart": 0,
        "chunkEnd": len(text),
        "metadata": metadata,
    }


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def sqlite_documents(request: dict[str, Any], store: dict[str, Any]) -> list[Any]:
    database_path = INPUT_ROOT / store["path"]
    if not database_path.exists():
        raise RuntimeError(f"sqlite store path does not exist: {store['path']}")
    connection = sqlite3.connect(database_path)
    try:
        tables = [row[0] for row in connection.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")]
        docs: list[Any] = []
        engine = create_engine(f"sqlite:///{database_path.as_posix()}")
        for table in tables:
            table_identifier = quoted_identifier(table)
            columns = list(connection.execute(f"pragma table_info({table_identifier})"))
            primary = next((row[1] for row in columns if row[5]), None)
            if not primary:
                continue
            primary_identifier = quoted_identifier(primary)
            base = source_metadata(request, store["id"], f"sqlite:{relative_path(database_path)}:{table}", "sqlite", database_path)
            sql = f'''select *,
                '{request['dkbId'].replace("'", "''")}' as dkb_package_id,
                '{request['version'].replace("'", "''")}' as dkb_package_version,
                '{base['dkb_source_id'].replace("'", "''")}' as dkb_source_id,
                '{base['dkb_store_id'].replace("'", "''")}' as dkb_store_id,
                'sqlite' as dkb_source_type,
                '{base['dkb_path'].replace("'", "''")}' as dkb_path,
                '{base['dkb_source_hash']}' as dkb_source_hash,
                '{table.replace("'", "''")}' as dkb_table,
                cast({primary_identifier} as text) as dkb_primary_key
                from {table_identifier} order by {primary_identifier}'''
            reader = DatabaseReader(engine=engine)
            metadata_cols = [
                "dkb_package_id", "dkb_package_version", "dkb_source_id", "dkb_store_id", "dkb_source_type",
                "dkb_path", "dkb_source_hash", "dkb_table", "dkb_primary_key",
            ]
            docs.extend(reader.load_data(
                query=sql,
                metadata_cols=metadata_cols,
                excluded_text_cols=metadata_cols,
                document_id=lambda row: f"{row['dkb_package_id']}:{row['dkb_package_version']}:sqlite:{row['dkb_table']}:{row['dkb_primary_key']}",
            ))
        return docs
    finally:
        connection.close()


def database_documents(request: dict[str, Any], source: dict[str, Any]) -> list[Any]:
    engine = create_engine(source["connection"])
    inspector = inspect(engine)
    dialect = engine.dialect.name
    include_tables = set(source.get("includeTables") or inspector.get_table_names())
    source_hash = digest_text(json.dumps({"id": source["id"], "dialect": dialect, "tables": sorted(include_tables)}, sort_keys=True))
    docs: list[Any] = []

    for table in sorted(include_tables):
        if table not in inspector.get_table_names():
            continue
        primary_columns = inspector.get_pk_constraint(table).get("constrained_columns") or []
        if not primary_columns:
            continue
        primary = primary_columns[0]
        quote = engine.dialect.identifier_preparer.quote
        table_identifier = quote(table)
        primary_identifier = quote(primary)
        source_id = f"database:{source['id']}:{table}"
        sql = f'''select *,
            '{request['dkbId'].replace("'", "''")}' as dkb_package_id,
            '{request['version'].replace("'", "''")}' as dkb_package_version,
            '{source_id.replace("'", "''")}' as dkb_source_id,
            '{source['id'].replace("'", "''")}' as dkb_store_id,
            'database' as dkb_source_type,
            'database:{source['id'].replace("'", "''")}' as dkb_path,
            '{source_hash}' as dkb_source_hash,
            '{table.replace("'", "''")}' as dkb_table,
            cast({primary_identifier} as text) as dkb_primary_key
            from {table_identifier} order by {primary_identifier}'''
        metadata_cols = [
            "dkb_package_id", "dkb_package_version", "dkb_source_id", "dkb_store_id", "dkb_source_type",
            "dkb_path", "dkb_source_hash", "dkb_table", "dkb_primary_key",
        ]
        reader = DatabaseReader(engine=engine)
        docs.extend(reader.load_data(
            query=sql,
            metadata_cols=metadata_cols,
            excluded_text_cols=metadata_cols,
            document_id=lambda row: f"{row['dkb_package_id']}:{row['dkb_package_version']}:database:{row['dkb_table']}:{row['dkb_primary_key']}",
        ))
    return docs


def node_record(node: Any) -> dict[str, Any]:
    metadata = dict(node.metadata)
    content = node.get_content(metadata_mode="none")
    source_type = metadata["dkb_source_type"]
    locator: dict[str, Any] = {"path": metadata["dkb_path"]}
    if source_type in {"sqlite", "database"}:
        locator = {"type": "row", "table": metadata["dkb_table"], "primaryKey": metadata["dkb_primary_key"]}
    start = node.start_char_idx if node.start_char_idx is not None else 0
    end = node.end_char_idx if node.end_char_idx is not None else start + len(content)
    identity = {
        "dkbId": metadata["dkb_package_id"],
        "storeId": metadata["dkb_store_id"],
        "type": source_type,
        "locator": locator,
        "ordinal": node.metadata.get("dkb_chunk_ordinal", 0),
        "text": content,
    }
    return {
        "id": digest_text(json.dumps(identity, sort_keys=True, separators=(",", ":"))),
        "assetId": digest_text(json.dumps({k: identity[k] for k in ["dkbId", "storeId", "type", "locator"]}, sort_keys=True, separators=(",", ":"))),
        "storeId": metadata["dkb_store_id"],
        "type": source_type,
        "locator": locator,
        "assetLocator": locator,
        "title": metadata.get("file_name") or metadata.get("dkb_table") or metadata["dkb_source_id"],
        "text": content,
        "hash": digest_text(content),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "chunkOrdinal": node.metadata.get("dkb_chunk_ordinal", 0),
        "chunkStart": start,
        "chunkEnd": end,
        "metadata": metadata,
    }


def rich_chunk_record(chunk: dict[str, Any]) -> dict[str, Any]:
    metadata = chunk["metadata"]
    identity = {
        "dkbId": metadata["dkb_package_id"],
        "storeId": chunk["storeId"],
        "type": chunk["type"],
        "locator": chunk["locator"],
        "ordinal": chunk["chunkOrdinal"],
        "text": chunk["text"],
    }
    asset_identity = {
        "dkbId": metadata["dkb_package_id"],
        "storeId": chunk["storeId"],
        "type": chunk["type"],
        "assetLocator": chunk["assetLocator"],
    }
    return {
        **chunk,
        "id": digest_text(json.dumps(identity, sort_keys=True, separators=(",", ":"))),
        "assetId": digest_text(json.dumps(asset_identity, sort_keys=True, separators=(",", ":"))),
    }


def node_asset_key(node: Any) -> str:
    return json.dumps({
        "source": node.metadata.get("dkb_source_id"),
        "path": node.metadata.get("dkb_path"),
        "table": node.metadata.get("dkb_table"),
        "primary": node.metadata.get("dkb_primary_key"),
    }, sort_keys=True)


def write_record(output: Any, records_output: Any, record: dict[str, Any], first_record: bool) -> bool:
    serialized = json.dumps(record, sort_keys=True, separators=(",", ":"))
    if not first_record:
        output.write(",")
    output.write(serialized)
    records_output.write(serialized)
    records_output.write("\n")
    return False


def write_node_records(
    output: Any,
    records_output: Any,
    nodes: list[Any],
    first_record: bool,
) -> tuple[bool, int]:
    record_count = 0
    for node in nodes:
        first_record = write_record(output, records_output, node_record(node), first_record)
        record_count += 1
    return first_record, record_count


def write_rich_records(
    output: Any,
    records_output: Any,
    rich_chunks: list[dict[str, Any]],
    first_record: bool,
) -> tuple[bool, int]:
    record_count = 0
    for chunk in rich_chunks:
        first_record = write_record(output, records_output, rich_chunk_record(chunk), first_record)
        record_count += 1
    return first_record, record_count


async def main_async() -> None:
    global _DOCLING_FALLBACKS
    started = time.perf_counter()
    request = json.loads(REQUEST.read_text(encoding="utf-8"))
    Settings.llm = None
    document_tasks: list[Any] = []
    for store in request["stores"]:
        if store["type"] == "filesystem":
            document_tasks.append(asyncio.to_thread(file_documents, request, store))
        elif store["type"] == "sqlite":
            document_tasks.append(asyncio.to_thread(sqlite_documents, request, store))
    for source in request.get("externalSources", []):
        if source["kind"] == "database":
            document_tasks.append(asyncio.to_thread(database_documents, request, source))
    loaded_at = time.perf_counter()
    docs: list[Any] = []
    rich_chunks: list[dict[str, Any]] = []
    for batch in await asyncio.gather(*document_tasks):
        if isinstance(batch, dict) and "documents" in batch:
            docs.extend(batch.get("documents") or [])
            rich_chunks.extend(batch.get("richChunks") or [])
            _DOCLING_FALLBACKS += int(batch.get("doclingFallbacks") or 0)
        else:
            docs.extend(batch)
    loaded_done_at = time.perf_counter()
    emit_event(
        "dkb.compiler.documents.ready",
        documents=len(docs),
        durationMs=round((loaded_done_at - loaded_at) * 1000, 3),
        richChunks=len(rich_chunks),
    )
    splitter = SentenceSplitter(chunk_size=512, chunk_overlap=64)
    ordinals: dict[str, int] = {}
    chunk_seconds = 0.0
    record_count = 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = OUTPUT.with_suffix(f"{OUTPUT.suffix}.tmp")
    records_output = OUTPUT.with_name("llamaindex-records.jsonl")
    temporary_records_output = records_output.with_suffix(f"{records_output.suffix}.tmp")
    metadata_output = OUTPUT.with_name("llamaindex-compiled.meta.json")
    temporary_metadata_output = metadata_output.with_suffix(f"{metadata_output.suffix}.tmp")
    try:
        with temporary_output.open("w", encoding="utf-8") as output, temporary_records_output.open("w", encoding="utf-8") as records:
            output.write('{"compiler":')
            json.dump({"id": "llamaindex.docling.evidence", "model": MODEL}, output, sort_keys=True, separators=(",", ":"))
            output.write(',"format":"dkb.llamaindex.compile.v2","records":[')
            first_record = True
            for offset in range(0, len(docs), DOCUMENT_BATCH_SIZE):
                document_batch = docs[offset:offset + DOCUMENT_BATCH_SIZE]
                chunk_started = time.perf_counter()
                nodes = list(splitter.get_nodes_from_documents(document_batch, show_progress=False))
                batch_chunk_seconds = time.perf_counter() - chunk_started
                chunk_seconds += batch_chunk_seconds
                for node in nodes:
                    asset_key = node_asset_key(node)
                    node.metadata["dkb_chunk_ordinal"] = ordinals.get(asset_key, 0)
                    ordinals[asset_key] = ordinals.get(asset_key, 0) + 1
                first_record, batch_record_count = write_node_records(
                    output,
                    records,
                    nodes,
                    first_record,
                )
                record_count += batch_record_count
                completed_documents = min(offset + len(document_batch), len(docs))
                batch_number = (offset // DOCUMENT_BATCH_SIZE) + 1
                if batch_number == 1 or completed_documents == len(docs) or batch_number % 5 == 0:
                    emit_event(
                        "dkb.compiler.documents.processed",
                        chunkMs=round(batch_chunk_seconds * 1000, 3),
                        completed=completed_documents,
                        records=record_count,
                        total=len(docs),
                    )
            first_record, rich_record_count = write_rich_records(
                output,
                records,
                rich_chunks,
                first_record,
            )
            record_count += rich_record_count
            completed_at = time.perf_counter()
            execution = {
                "mode": "embedding-free-evidence",
                "workers": ASYNC_WORKERS,
                "batching": {
                    "documentBatchSize": DOCUMENT_BATCH_SIZE,
                    "recordCount": record_count,
                },
                "timingsMs": {
                    "startup": round((loaded_at - started) * 1000, 3),
                    "load": round((loaded_done_at - loaded_at) * 1000, 3),
                    "chunk": round(chunk_seconds * 1000, 3),
                    "total": round((completed_at - started) * 1000, 3),
                    "doclingTokenizer": round(_COMPILER_TIMINGS["doclingTokenizer"], 3),
                    "doclingConversion": round(_COMPILER_TIMINGS["doclingConversion"], 3),
                    "doclingChunk": round(_COMPILER_TIMINGS["doclingChunk"], 3),
                },
                "docling": {
                    "enabled": DOCLING_ENABLED,
                    "fallbackEnabled": DOCLING_FALLBACK,
                    "extensions": sorted(docling_extensions()),
                    "files": _DOCLING_FILES,
                    "fallbacks": _DOCLING_FALLBACKS,
                },
            }
            output.write('],"execution":')
            json.dump(execution, output, sort_keys=True, separators=(",", ":"))
            output.write("}")
        temporary_metadata_output.write_text(json.dumps({
            "compiler": {"id": "llamaindex.docling.evidence", "model": MODEL},
            "execution": execution,
            "format": "dkb.llamaindex.compile.v2",
            "recordsFile": records_output.name,
            "recordCount": record_count,
        }, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        temporary_records_output.replace(records_output)
        temporary_metadata_output.replace(metadata_output)
        temporary_output.replace(OUTPUT)
    except Exception:
        temporary_output.unlink(missing_ok=True)
        temporary_records_output.unlink(missing_ok=True)
        temporary_metadata_output.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    asyncio.run(main_async())
