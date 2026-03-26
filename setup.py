from setuptools import setup, find_packages

with open("requirements.txt") as f:
    install_requires = f.read().strip().split("\n")

setup(
    name="libracad",
    version="0.1.0",
    description="Web-based 2D CAD for corrugated die layout creation, linked to Corrugated Estimating",
    author="Welchwyse",
    author_email="admin@welchwyse.com",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
