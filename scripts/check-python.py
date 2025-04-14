#!/usr/bin/env python3
"""
Diagnostic script to check Python environment for radio recorder
"""
import sys
import subprocess
import os

def run_check(title, command):
    print(f"\n{title}")
    print("-" * len(title))
    try:
        output = subprocess.check_output(command, shell=True, stderr=subprocess.STDOUT).decode('utf-8')
        print(output)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error: {e.output.decode('utf-8')}")
        return False

def check_module(module_name):
    print(f"\nChecking module: {module_name}")
    print("-" * (16 + len(module_name)))
    try:
        cmd = f"python3 -c 'import {module_name}; print(\"✓ Successfully imported {module_name}\", {module_name}.__version__ if hasattr({module_name}, \"__version__\") else \"\")'"
        output = subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT).decode('utf-8')
        print(output)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error importing {module_name}: {e.output.decode('utf-8')}")
        return False

def main():
    print("Python Environment Diagnostic Tool")
    print("=================================")
    print(f"Python version: {sys.version}")
    print(f"Path: {sys.executable}")
    
    modules = ['boto3', 'botocore', 'requests', 'argparse', 'logging']
    
    all_passed = True
    
    # Check Python modules
    for module in modules:
        if not check_module(module):
            all_passed = False
    
    # Check AWS Config
    if not run_check("AWS Configuration", "aws configure list"):
        all_passed = False
    
    # Check boto3 credentials
    try:
        print("\nChecking AWS credentials with boto3")
        print("-" * 30)
        code = """
import boto3
session = boto3.session.Session()
credentials = session.get_credentials()
if credentials:
    print(f"✓ Found credentials for profile: {session.profile_name or 'default'}")
    print(f"Region: {session.region_name or 'not set'}")
else:
    print("✗ No credentials found")
try:
    s3 = boto3.client('s3')
    buckets = s3.list_buckets()
    print(f"✓ Successfully connected to S3. Found {len(buckets['Buckets'])} buckets")
    for bucket in buckets['Buckets']:
        print(f"  - {bucket['Name']}")
except Exception as e:
    print(f"✗ Error connecting to S3: {e}")
"""
        output = subprocess.check_output(f"python3 -c '{code}'", shell=True, stderr=subprocess.STDOUT).decode('utf-8')
        print(output)
    except subprocess.CalledProcessError as e:
        print(f"Error checking boto3 credentials: {e.output.decode('utf-8')}")
        all_passed = False
    
    # Check ffmpeg
    if not run_check("FFmpeg Installation", "ffmpeg -version"):
        all_passed = False
    
    # Check permissions
    print("\nChecking file permissions")
    print("-" * 24)
    paths_to_check = [
        "/tmp",
        "/home/ec2-user",
        "/opt/radio-recorder"
    ]
    
    for path in paths_to_check:
        print(f"\nChecking {path}:")
        if not os.path.exists(path):
            print(f"✗ Path does not exist: {path}")
            all_passed = False
            continue
            
        try:
            # Check if directory is writable
            test_file = os.path.join(path, ".permission_test")
            with open(test_file, 'w') as f:
                f.write("test")
            os.remove(test_file)
            print(f"✓ Directory is writable: {path}")
        except Exception as e:
            print(f"✗ Cannot write to directory {path}: {e}")
            all_passed = False
            
        # Show directory permissions
        try:
            output = subprocess.check_output(f"ls -la {path} | head -5", shell=True, stderr=subprocess.STDOUT).decode('utf-8')
            print(f"Directory listing:\n{output}")
        except subprocess.CalledProcessError as e:
            print(f"Error listing directory: {e.output.decode('utf-8')}")
    
    # Overall result
    print("\nDiagnostic Summary")
    print("-" * 17)
    if all_passed:
        print("✅ All checks passed!")
    else:
        print("❌ Some checks failed. See details above.")

if __name__ == "__main__":
    main()