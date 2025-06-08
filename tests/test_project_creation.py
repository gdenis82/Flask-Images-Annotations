import unittest
import os
import sys
import json
import tempfile
import shutil
from io import BytesIO
from PIL import Image

# Add the parent directory to the path so we can import from app
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Import the Flask app
from app import app

class TestProjectCreation(unittest.TestCase):
    """Test the project creation functionality."""
    
    def setUp(self):
        """Set up the test environment."""
        # Configure the app for testing
        app.config['TESTING'] = True
        app.config['DEBUG'] = False
        
        # Create a temporary directory for projects
        self.temp_dir = tempfile.mkdtemp()
        app.config['PROJECTS_FOLDER'] = self.temp_dir
        
        # Create a test client
        self.client = app.test_client()
        
        # Store the original projects folder
        self.original_projects_folder = app.config.get('PROJECTS_FOLDER')
    
    def tearDown(self):
        """Clean up after the tests."""
        # Remove the temporary directory
        shutil.rmtree(self.temp_dir)
        
        # Restore the original projects folder
        if self.original_projects_folder:
            app.config['PROJECTS_FOLDER'] = self.original_projects_folder
    
    def test_create_project(self):
        """Test creating a new project."""
        # Define project data
        project_data = {
            'name': 'Test Project',
            'classes': ['Person', 'Car', 'Dog'],
            'classColors': {
                'Person': '#FF0000',
                'Car': '#00FF00',
                'Dog': '#0000FF'
            }
        }
        
        # Send a POST request to create a project
        response = self.client.post(
            '/projects',
            data=json.dumps(project_data),
            content_type='application/json'
        )
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify the response data
        self.assertIn('id', data)
        self.assertEqual(data['name'], project_data['name'])
        self.assertEqual(data['classes'], project_data['classes'])
        self.assertEqual(data['classColors'], project_data['classColors'])
        
        # Verify that the project directory was created
        project_path = os.path.join(self.temp_dir, data['id'])
        self.assertTrue(os.path.exists(project_path))
        
        # Verify that the project subdirectories were created
        self.assertTrue(os.path.exists(os.path.join(project_path, 'images')))
        self.assertTrue(os.path.exists(os.path.join(project_path, 'annotations')))
        self.assertTrue(os.path.exists(os.path.join(project_path, 'export')))
        
        # Verify that the config.json file was created
        config_path = os.path.join(project_path, 'config.json')
        self.assertTrue(os.path.exists(config_path))
        
        # Verify the content of the config.json file
        with open(config_path, 'r') as f:
            config = json.load(f)
        
        self.assertEqual(config['name'], project_data['name'])
        self.assertEqual(config['classes'], project_data['classes'])
        self.assertEqual(config['classColors'], project_data['classColors'])
        
        return data['id']  # Return the project ID for use in other tests
    
    def test_get_projects(self):
        """Test retrieving the list of projects."""
        # Create a test project
        project_id = self.test_create_project()
        
        # Send a GET request to retrieve the list of projects
        response = self.client.get('/projects')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify that the list contains the test project
        self.assertTrue(any(p['id'] == project_id for p in data))
    
    def test_get_project(self):
        """Test retrieving a specific project."""
        # Create a test project
        project_id = self.test_create_project()
        
        # Send a GET request to retrieve the project
        response = self.client.get(f'/projects/{project_id}')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify the project data
        self.assertEqual(data['id'], project_id)
        self.assertEqual(data['name'], 'Test Project')
        self.assertEqual(data['classes'], ['Person', 'Car', 'Dog'])
    
    def test_update_project(self):
        """Test updating a project."""
        # Create a test project
        project_id = self.test_create_project()
        
        # Define updated project data
        updated_data = {
            'name': 'Updated Project',
            'classes': ['Person', 'Car', 'Dog', 'Cat'],
            'classColors': {
                'Person': '#FF0000',
                'Car': '#00FF00',
                'Dog': '#0000FF',
                'Cat': '#FFFF00'
            }
        }
        
        # Send a PUT request to update the project
        response = self.client.put(
            f'/projects/{project_id}',
            data=json.dumps(updated_data),
            content_type='application/json'
        )
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify the updated project data
        self.assertEqual(data['id'], project_id)
        self.assertEqual(data['name'], updated_data['name'])
        self.assertEqual(data['classes'], updated_data['classes'])
        self.assertEqual(data['classColors'], updated_data['classColors'])
        
        # Verify that the config.json file was updated
        config_path = os.path.join(self.temp_dir, project_id, 'config.json')
        with open(config_path, 'r') as f:
            config = json.load(f)
        
        self.assertEqual(config['name'], updated_data['name'])
        self.assertEqual(config['classes'], updated_data['classes'])
        self.assertEqual(config['classColors'], updated_data['classColors'])
    
    def test_delete_project(self):
        """Test deleting a project."""
        # Create a test project
        project_id = self.test_create_project()
        
        # Verify that the project directory exists
        project_path = os.path.join(self.temp_dir, project_id)
        self.assertTrue(os.path.exists(project_path))
        
        # Send a DELETE request to delete the project
        response = self.client.delete(f'/projects/{project_id}')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data['success'])
        
        # Verify that the project directory was deleted
        self.assertFalse(os.path.exists(project_path))

if __name__ == '__main__':
    unittest.main()