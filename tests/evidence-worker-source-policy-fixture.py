"""Actual worker request/SQLite adapters with third-party transport mocked.

This contract fixture uses only its own temporary SQLite database. It does not
prove a running Docling, SQLAlchemy, or external database service.
"""
import asyncio
import importlib.util
import json
import pathlib
import sqlite3
import sys
import types
from unittest.mock import patch


class Document:
    def __init__(self, text, metadata, id_):
        self.text, self.metadata, self.id_ = text, metadata, id_


engine_calls = []


def create_engine(url):
    assert url.startswith("sqlite:///"), "fixture must never open a remote database"
    engine_calls.append(url)
    return types.SimpleNamespace(path=url.removeprefix("sqlite:///"))


class DatabaseReader:
    def __init__(self, engine):
        self.engine = engine

    def load_data(self, query, metadata_cols, excluded_text_cols, document_id):
        with sqlite3.connect(self.engine.path) as connection:
            connection.row_factory = sqlite3.Row
            rows = [dict(row) for row in connection.execute(query)]
        return [Document(
            text=" ".join(str(value) for key, value in row.items() if key not in excluded_text_cols),
            metadata={key: row[key] for key in metadata_cols}, id_=document_id(row),
        ) for row in rows]


def module(name, **exports):
    value = types.ModuleType(name)
    value.__dict__.update(exports)
    sys.modules[name] = value


settings = types.SimpleNamespace(llm="not-touched")
module("llama_index")
module("llama_index.core", Document=Document, Settings=settings, SimpleDirectoryReader=object)
module("llama_index.core.node_parser", SentenceSplitter=object)
module("llama_index.readers")
module("llama_index.readers.database", DatabaseReader=DatabaseReader)
module("sqlalchemy", create_engine=create_engine)
provider = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(provider))
spec = importlib.util.spec_from_file_location("evidence_worker", provider / "compile.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.INPUT_ROOT = pathlib.Path(sys.argv[2])
worker.REQUEST = worker.INPUT_ROOT / "request.json"

rejected = 0
for external in (None, [], {}, [{"kind": "database", "connection": "fixture-secret-dsn"} ]):
    worker.REQUEST.write_text(json.dumps({"stores": [{"type": "sqlite", "path": "absent.sqlite"}],
                                        "externalSources": external}), encoding="utf-8")
    try:
        asyncio.run(worker.main_async())
    except ValueError as error:
        assert "immutable database snapshot" in str(error)
        assert "fixture-secret-dsn" not in str(error)
        rejected += 1
    else:
        raise AssertionError("worker accepted a retired externalSources request")
    assert settings.llm == "not-touched", "request must fail before dispatch"
    assert engine_calls == [], "rejected requests must not connect to a database"
assert not hasattr(worker, "database_documents"), "retired live connection reader must not remain callable"

outside = worker.INPUT_ROOT.parent / "outside-fixture.sqlite"
outside.write_bytes(b"fixture-owned outside source; do not read as a database")
rejected_paths = 0
for source_path in ("../outside-fixture.sqlite", outside.as_posix()):
    with patch.object(sqlite3, "connect", side_effect=AssertionError("outside source reached SQLite connect")):
        try:
            worker.sqlite_documents({"dkbId": "@proof/database-snapshot", "version": "1.0.0"},
                                    {"id": "snapshot", "type": "sqlite", "path": source_path})
        except RuntimeError as error:
            assert "outside compiler input root" in str(error)
            rejected_paths += 1
        else:
            raise AssertionError("SQLite adapter accepted a source outside its package")
    assert engine_calls == []
assert outside.read_bytes() == b"fixture-owned outside source; do not read as a database"

database = worker.INPUT_ROOT / "facts.sqlite"
with sqlite3.connect(database) as connection:
    connection.execute("create table facts (id integer primary key, title text, body text)")
    connection.execute("insert into facts values (1, 'Snapshot proof', 'SQLITE-SOURCE-52')")

request = {"dkbId": "@proof/database-snapshot", "version": "1.0.0",
           "stores": [{"id": "snapshot", "type": "sqlite", "path": "facts.sqlite"}]}
worker.validate_source_request(request)


def records():
    docs = worker.sqlite_documents(request, request["stores"][0])
    return [worker.node_record(types.SimpleNamespace(metadata=document.metadata,
            start_char_idx=0, end_char_idx=len(document.text),
            get_content=lambda metadata_mode, document=document: document.text)) for document in docs]


before_hash = worker.digest_bytes(database.read_bytes())
before = records()
assert len(before) == 1
assert before[0]["sourceHash"] == before_hash
assert before[0]["sourceHash"] != before[0]["hash"]
assert before[0]["locator"] == {"type": "row", "table": "facts", "primaryKey": "1"}
assert before[0]["assetLocator"] == {"type": "row", "table": "facts", "primaryKey": "1", "path": "facts.sqlite"}
with sqlite3.connect(database) as connection:
    connection.execute("update facts set body = 'SQLITE-UPDATED-53' where id = 1")
after_hash = worker.digest_bytes(database.read_bytes())
after = records()
assert after_hash != before_hash
assert after[0]["sourceHash"] == after_hash
assert after[0]["assetId"] == before[0]["assetId"]
assert after[0]["assetLocator"] == before[0]["assetLocator"]
assert after[0]["locator"] == before[0]["locator"]
assert len(engine_calls) == 2
print(json.dumps({"rejectedRequests": rejected, "rejectedPaths": rejected_paths, "before": before, "after": after,
                  "beforeSourceHash": before_hash, "afterSourceHash": after_hash}))
