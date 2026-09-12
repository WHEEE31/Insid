"""HTTP routes for recording and retrieving indoor walks."""

from flask import Blueprint, current_app, jsonify, request


walks = Blueprint("walks", __name__)


def _database():
    return current_app.config["DATABASE"]


@walks.post("/walks")
def create_walk():
    payload = request.get_json(silent=True) or {}
    floor = payload.get("floor", 1)
    readings = payload.get("readings", payload.get("raw_readings", []))
    if not isinstance(floor, int) or not isinstance(readings, list):
        return jsonify(error="floor must be an integer and readings must be a list"), 400

    walk_id = _database().create_walk(floor=floor, raw_readings=readings)
    return jsonify(_database().get_walk(walk_id)), 201


@walks.patch("/walks/<int:walk_id>/path")
def update_walk_path(walk_id: int):
    payload = request.get_json(silent=True) or {}
    path = payload.get("path")
    if not isinstance(path, list):
        return jsonify(error="path must be a list"), 400
    if _database().get_walk(walk_id) is None:
        return jsonify(error="walk not found"), 404

    _database().set_processed_path(walk_id, path)
    return jsonify(_database().get_walk(walk_id))


@walks.get("/walks")
def list_walks():
    floor = request.args.get("floor", type=int)
    result = (
        _database().get_walks_by_floor(floor)
        if floor is not None
        else _database().get_all_walks()
    )
    return jsonify(result)
