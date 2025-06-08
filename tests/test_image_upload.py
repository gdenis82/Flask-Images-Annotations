import unittest
import os
import sys
import json
import time
import tempfile
import shutil
from io import BytesIO
from PIL import Image

# Add the parent directory to the path so we can import from app
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Import the Flask app
from app import app, redis_client

class TestImageUpload(unittest.TestCase):
    """Test the image upload functionality."""
    
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
        
        # Create a test project
        self.project_id = self.create_test_project()
    
    def tearDown(self):
        """Clean up after the tests."""
        # Remove the temporary directory
        shutil.rmtree(self.temp_dir)
        
        # Restore the original projects folder
        if self.original_projects_folder:
            app.config['PROJECTS_FOLDER'] = self.original_projects_folder
    
    def create_test_project(self):
        """Create a test project for image upload tests."""
        # Define project data
        project_data = {
            'name': 'Test Image Upload Project',
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
        
        return data['id']
    
    def create_test_image(self, filename='test_image.jpg', width=100, height=100, color=(255, 0, 0)):
        """Create a test image for upload tests."""
        # Create a test image
        image = Image.new('RGB', (width, height), color=color)
        
        # Save the image to a BytesIO object
        image_io = BytesIO()
        image.save(image_io, format='JPEG')
        image_io.seek(0)
        
        return image_io, filename
    
    def test_upload_image(self):
        """Test uploading an image to a project."""
        # Create a test image
        image_io, filename = self.create_test_image()
        
        # Send a POST request to upload the image
        response = self.client.post(
            f'/projects/{self.project_id}/upload',
            data={
                'file': (image_io, filename)
            },
            content_type='multipart/form-data'
        )
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify the response data
        self.assertTrue(data['success'])
        self.assertIn('task_id', data)
        self.assertEqual(data['status'], 'queued')
        
        # Wait for the task to complete (with timeout)
        task_id = data['task_id']
        timeout = 30
        start_time = time.time()
        status = 'queued'
        
        while status in ['queued', 'processing'] and time.time() - start_time < timeout:
            # Check the task status
            status_response = self.client.get(f'/projects/{self.project_id}/upload/status/{task_id}')
            status_data = json.loads(status_response.data)
            status = status_data.get('status')
            time.sleep(0.5)
        
        # Verify that the task completed successfully
        self.assertEqual(status, 'completed')
        
        # Verify that the image file was created
        images_path = os.path.join(self.temp_dir, self.project_id, 'images')
        image_path = os.path.join(images_path, filename)
        self.assertTrue(os.path.exists(image_path))
        
        # Verify that the image was added to the images list
        images_list_file = os.path.join(images_path, 'images_list.json')
        self.assertTrue(os.path.exists(images_list_file))
        
        with open(images_list_file, 'r') as f:
            images_list = json.load(f)
        
        self.assertIn('images', images_list)
        self.assertTrue(any(img.get('name') == filename for img in images_list['images']))
        
        return filename
    
    def test_get_project_images(self):
        """Test retrieving the list of images for a project."""
        # Upload a test image
        filename = self.test_upload_image()
        
        # Send a GET request to retrieve the list of images
        response = self.client.get(f'/projects/{self.project_id}/images')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Verify that the list contains the test image
        self.assertIn('images', data)
        self.assertTrue(any(img.get('name') == filename for img in data['images']))
    
    def test_get_image(self):
        """Test retrieving an image from a project."""
        # Upload a test image
        filename = self.test_upload_image()
        
        # Send a GET request to retrieve the image
        response = self.client.get(f'/projects/{self.project_id}/images/{filename}')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, 'image/jpeg')
        
        # Verify that the image data is correct
        image_data = BytesIO(response.data)
        image = Image.open(image_data)
        self.assertEqual(image.size, (100, 100))
    
    def test_delete_image(self):
        """Test deleting an image from a project."""
        # Upload a test image
        filename = self.test_upload_image()
        
        # Verify that the image file exists
        image_path = os.path.join(self.temp_dir, self.project_id, 'images', filename)
        self.assertTrue(os.path.exists(image_path))
        
        # Send a DELETE request to delete the image
        response = self.client.delete(f'/projects/{self.project_id}/images/{filename}')
        
        # Check the response
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data['success'])
        
        # Verify that the image file was deleted
        self.assertFalse(os.path.exists(image_path))
        
        # Verify that the image was removed from the images list
        images_list_file = os.path.join(self.temp_dir, self.project_id, 'images', 'images_list.json')
        
        with open(images_list_file, 'r') as f:
            images_list = json.load(f)
        
        self.assertIn('images', images_list)
        self.assertFalse(any(img.get('name') == filename for img in images_list['images']))
    
    def test_upload_multiple_images(self):
        """Test uploading multiple images to a project."""
        # Create test images
        image_io1, filename1 = self.create_test_image('test_image1.jpg', color=(255, 0, 0))
        image_io2, filename2 = self.create_test_image('test_image2.jpg', color=(0, 255, 0))
        image_io3, filename3 = self.create_test_image('test_image3.jpg', color=(0, 0, 255))
        
        # Upload the images
        for image_io, filename in [(image_io1, filename1), (image_io2, filename2), (image_io3, filename3)]:
            response = self.client.post(
                f'/projects/{self.project_id}/upload',
                data={
                    'file': (image_io, filename)
                },
                content_type='multipart/form-data'
            )
            
            # Check the response
            self.assertEqual(response.status_code, 200)
            data = json.loads(response.data)
            self.assertTrue(data['success'])
        
        # Wait for all tasks to complete
        time.sleep(5)
        
        # Verify that all image files were created
        images_path = os.path.join(self.temp_dir, self.project_id, 'images')
        for filename in [filename1, filename2, filename3]:
            image_path = os.path.join(images_path, filename)
            self.assertTrue(os.path.exists(image_path))
        
        # Verify that all images were added to the images list
        images_list_file = os.path.join(images_path, 'images_list.json')
        
        with open(images_list_file, 'r') as f:
            images_list = json.load(f)
        
        self.assertIn('images', images_list)
        for filename in [filename1, filename2, filename3]:
            self.assertTrue(any(img.get('name') == filename for img in images_list['images']))

if __name__ == '__main__':
    unittest.main()