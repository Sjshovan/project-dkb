"""Exercise real worker record adapters, not the unavailable Docling models."""
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import types
from unittest.mock import patch


class Document:
    def __init__(self, text, metadata, id_):
        self.text, self.metadata, self.id_ = text, metadata, id_


def module(name, **exports):
    value = types.ModuleType(name)
    value.__dict__.update(exports)
    sys.modules[name] = value


# Model and database libraries are not exercised by this adapter contract test.
module("llama_index")
module("llama_index.core", Document=Document, Settings=object(), SimpleDirectoryReader=object)
module("llama_index.core.node_parser", SentenceSplitter=object)
module("llama_index.readers")
module("llama_index.readers.database", DatabaseReader=object)
module("sqlalchemy", create_engine=object, inspect=object)
provider = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(provider))
spec = importlib.util.spec_from_file_location("evidence_worker", provider / "compile.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.INPUT_ROOT = pathlib.Path(sys.argv[2])
target = worker.INPUT_ROOT / "facts.html"
source = target.read_bytes()
source_hash = worker.digest_bytes(source)
request = {"dkbId": "@proof/source-anchors", "version": "1.0.0"}
store = {"id": "files", "path": ".", "includePaths": ["facts.html"]}


class Chunk:
    def __init__(self, ordinal):
        self.ordinal = ordinal

    def model_dump(self, mode):
        return {"meta": {"doc_items": [{"self_ref": f"#/tables/{self.ordinal}", "label": "table", "prov": [{"page_no": 1}]}]}}


worker.docling_tools = lambda: (
    types.SimpleNamespace(convert=lambda _target: types.SimpleNamespace(document=object())),
    types.SimpleNamespace(chunk=lambda **_kwargs: [Chunk(i) for i in range(3)],
                          contextualize=lambda chunk: f"Parsed table {chunk.ordinal}: WHALE-BUBBLE-73."),
)
worker.configure_evidence({"richFiles": True, "richFileFallback": False})
reads = []
read_bytes = pathlib.Path.read_bytes


def count_read(file):
    reads.append(file)
    return read_bytes(file)


with patch.object(pathlib.Path, "read_bytes", count_read), contextlib.redirect_stdout(io.StringIO()):
    rich_loaded = worker.file_documents(request, store)
rich = [worker.rich_chunk_record(chunk) for chunk in rich_loaded["richChunks"]]
assert reads == [target], "the source file must not be rehashed once per rich chunk"


def records_from_documents(loaded):
    result = []
    for document in loaded["documents"]:
        for ordinal, (start, end) in enumerate(((0, 30), (30, len(document.text)))):
            text = document.text[start:end]
            node = types.SimpleNamespace(metadata={**document.metadata, "dkb_chunk_ordinal": ordinal},
                                         start_char_idx=start, end_char_idx=end,
                                         get_content=lambda metadata_mode, text=text: text)
            result.append(worker.node_record(node))
    return result


worker.configure_evidence({"richFiles": False})
with contextlib.redirect_stdout(io.StringIO()):
    plain = records_from_documents(worker.file_documents(request, store))


def broken_tools():
    raise ValueError("synthetic conversion failure")


worker.docling_tools = broken_tools
worker.configure_evidence({"richFiles": True, "richFileFallback": True})
with contextlib.redirect_stdout(io.StringIO()):
    fallback = records_from_documents(worker.file_documents(request, store))

# Strict rich parsing must still fail instead of silently choosing the fallback.
worker.configure_evidence({"richFiles": True, "richFileFallback": False})
with contextlib.redirect_stdout(io.StringIO()):
    try:
        worker.file_documents(request, store)
    except RuntimeError:
        pass
    else:
        raise AssertionError("strict rich parsing accepted the fallback")

for record in rich + plain + fallback:
    assert record["sourceHash"] == source_hash
    assert record["sourceHash"] != record["hash"]
    assert record["assetLocator"] == {"path": "facts.html"}
assert len({record["assetId"] for record in rich + plain + fallback}) == 1
print(json.dumps({"rich": rich, "plain": plain, "fallback": fallback, "sourceHash": source_hash}))
