"""Flask application entry point for the HackCMU indoor mapping backend."""

from flask import Flask

from app.utils.api import walks
from app.utils.database import Database


def create_app(database_path: str = "indoor_map.db") -> Flask:
    app = Flask(__name__)
    database = Database(database_path)
    database.init_schema()
    app.config["DATABASE"] = database
    app.register_blueprint(walks, url_prefix="/api")
    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)
